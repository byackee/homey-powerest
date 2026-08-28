/**
 * `lib/energy.mts` — l'intégrateur qui transforme des watts en kWh.
 *
 * Homey exige de `meter_power` qu'il soit **monotone croissant** : il calcule la consommation par
 * différence entre deux relevés. Un compteur qui recule d'un pas produit une consommation
 * négative, puis un pic absurde au relevé suivant. Cette contrainte est la raison d'être du
 * module : l'accumulation est la seule opération autorisée ici, il n'y a pas de remise à zéro.
 */

/** État persisté du compteur. Sérialisé tel quel dans le `store` de l'appareil. */
export interface MeterState {
  /** Énergie cumulée, en kWh. */
  kwh: number;
  /** Horodatage du dernier échantillon, en ms epoch. */
  lastTs: number;
  /** Puissance retenue depuis cet horodatage, en W. */
  lastW: number;
}

/**
 * Écart maximal comblé par extrapolation.
 *
 * Au-delà, on ne sait honnêtement pas ce qui s'est passé : Homey a pu redémarrer, l'app a pu être
 * arrêtée une nuit entière. Prolonger la dernière puissance connue sur douze heures fabriquerait
 * des kWh qui n'ont jamais été consommés, et comme le compteur est monotone, l'erreur serait
 * définitive. On préfère un trou dans le comptage à un mensonge irréversible.
 */
export const MAX_GAP_MS = 15 * 60_000;

export function initialMeter(now: number, watts = 0): MeterState {
  return { kwh: 0, lastTs: now, lastW: watts };
}

/**
 * Intègre jusqu'à `now`, puis retient `watts` pour la suite.
 *
 * L'intégration est à main gauche — la puissance précédente vaut pour tout l'intervalle qui vient
 * de s'écouler — parce que c'est exactement ce que décrit un appareil : la lampe est restée à
 * cette luminosité jusqu'à l'instant où elle a changé.
 */
export function accumulate(state: MeterState, watts: number, now: number): MeterState {
  const safeWatts = Number.isFinite(watts) && watts > 0 ? watts : 0;
  const dt = now - state.lastTs;

  // Une horloge qui recule (synchronisation NTP au démarrage) ne doit pas retirer d'énergie.
  if (!Number.isFinite(dt) || dt <= 0) {
    return { kwh: state.kwh, lastTs: now, lastW: safeWatts };
  }

  const counted = Math.min(dt, MAX_GAP_MS);
  const added = (state.lastW * counted) / 3_600_000_000;

  return {
    kwh: state.kwh + (Number.isFinite(added) && added > 0 ? added : 0),
    lastTs: now,
    lastW: safeWatts,
  };
}

/**
 * Relit un état venu du `store`, en refusant tout ce qui casserait la monotonie.
 *
 * Un `store` corrompu ou une version antérieure du schéma donnerait `NaN`, et `NaN` écrit dans
 * `meter_power` fige la capability sans erreur visible.
 */
export function restoreMeter(raw: unknown, now: number): MeterState {
  if (raw && typeof raw === 'object') {
    const candidate = raw as Partial<MeterState>;
    const kwh = candidate.kwh;
    if (typeof kwh === 'number' && Number.isFinite(kwh) && kwh >= 0) {
      const lastTs = typeof candidate.lastTs === 'number' && Number.isFinite(candidate.lastTs)
        ? candidate.lastTs
        : now;
      const lastW = typeof candidate.lastW === 'number' && Number.isFinite(candidate.lastW) && candidate.lastW > 0
        ? candidate.lastW
        : 0;
      return { kwh, lastTs, lastW };
    }
  }
  return initialMeter(now);
}

/** Arrondi d'affichage du compteur : le Wh, en dessous Homey n'affiche rien de stable. */
export function roundKwh(kwh: number): number {
  return Math.round(kwh * 1000) / 1000;
}
