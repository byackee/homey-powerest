/**
 * `drivers/estimator/driver.mts` — le pairing.
 *
 * Une seule vue personnalisée, qui liste les appareils sans mesure de puissance et affiche le
 * profil trouvé pour chacun. La vue appelle `Homey.createDevice()` puis `Homey.done()` : d'après
 * l'expérience des autres apps du même auteur, enchaîner une vue custom sur un template système
 * laisse un écran blanc figé, `showView()` et `nextView()` échouant tous les deux.
 */

import Homey from 'homey';

import type PowerEstimateApp from '../../app.mjs';
import type { Candidate } from '../../app.mjs';
import { plannedCapabilities } from '../../lib/mirror.mjs';
import { SUPPORTED_STRATEGIES } from '../../lib/types.mjs';

/** Ce que la vue de pairing reçoit. Volontairement plat : elle n'a pas de logique. */
interface CandidateView {
  id: string;
  name: string;
  zone: string | null;
  deviceClass: string;
  profile: string | null;
  strategy: string | null;
  detail: string;
  selectable: boolean;
  warning: string | null;
  /** Forfait déjà attribué par Homey, en watts. `null` s'il n'y en a pas. */
  homeyWatts: number | null;
}

export default class EstimatorDriver extends Homey.Driver {
  private get app(): PowerEstimateApp {
    return this.homey.app as PowerEstimateApp;
  }

  public override async onPair(session: Homey.Driver.PairSession): Promise<void> {
    // Instrumentation dès la première ligne : sans elle, une erreur JS dans la vue de pairing est
    // totalement invisible sur une app installée.
    session.setHandler('viewLog', async (line: string) => {
      this.log(`[pair] ${String(line).slice(0, 500)}`);
      return true;
    });

    session.setHandler('list', async (): Promise<{ ready: boolean; error: string | null; items: CandidateView[] }> => {
      const index = this.app.getIndex();
      if (!index) {
        return { ready: false, error: this.app.getIndexError(), items: [] };
      }
      return { ready: true, error: null, items: this.app.listCandidates().map((c) => toView(c)) };
    });

    session.setHandler('refresh', async (): Promise<boolean> => {
      await this.app.getHub().refresh(true);
      await this.app.warmIndex(true);
      return true;
    });

    session.setHandler('build', async (deviceId: string) => {
      const candidate = this.app.listCandidates().find((c) => c.device.id === deviceId);
      if (!candidate) throw new Error(this.homey.__('pair.gone'));

      // Un appareil sans profil exploitable n'est PAS refusé : il est créé en saisie manuelle.
      // C'est le seul moyen de couvrir ce que la bibliothèque ignore — sur un parc réel, 12 des
      // 35 candidats — et de corriger un profil qui décrit autre chose que la charge mesurée.
      //
      // La stratégie se décide ICI et pas dans la liste. L'index ne la publie plus : la lire pour
      // les 747 modèles à chaque ouverture de la vue coûterait 747 requêtes, alors qu'un seul
      // modèle compte — celui qu'on vient de choisir. L'appel amorce au passage le cache du
      // profil, qui sera de toute façon nécessaire dans la seconde qui suit.
      let usable = candidate.match !== null;
      if (candidate.match !== null) {
        try {
          const meta = await this.app.getLibrary().getMeta(candidate.match);
          usable = SUPPORTED_STRATEGIES.has(meta.strategy);
          if (!usable) this.log(`[pair] ${candidate.match.model} : stratégie ${meta.strategy} non gérée, saisie manuelle`);
        } catch (err) {
          // Une bibliothèque injoignable ne doit pas bloquer l'ajout : la saisie manuelle marche
          // hors ligne, et c'est un bien meilleur repli qu'un appareil qu'on ne peut pas créer.
          usable = false;
          this.log(`[pair] profil ${candidate.match.model} indisponible, saisie manuelle : ${String(err)}`);
        }
      }

      return {
        name: candidate.device.name,
        data: { id: `estimate:${candidate.device.id}` },
        // Le compagnon reprend les commandes de la source pour pouvoir la REMPLACER dans
        // l'interface. Le SDK n'accepte à l'appairage que name/data/store/settings/icon/
        // capabilities/capabilitiesOptions — toute autre clé est ignorée en silence.
        capabilities: plannedCapabilities(candidate.device.capabilities),
        store: {
          sourceId: candidate.device.id,
          sourceClass: candidate.device.class,
          manufacturer: usable ? candidate.match?.manufacturer ?? '' : '',
          model: usable ? candidate.match?.model ?? '' : '',
        },
        settings: {
          source_name: `${candidate.device.name}${candidate.device.zoneName ? ` — ${candidate.device.zoneName}` : ''}`,
          profile_label: usable ? candidate.match?.label ?? '' : this.homey.__('pair.manual'),
          mode: usable ? 'profile' : 'fixed',
        },
      };
    });
  }
}

function toView(candidate: Candidate): CandidateView {
  const { device, match } = candidate;
  if (!match) {
    return {
      id: device.id,
      name: device.name,
      zone: device.zoneName,
      deviceClass: device.class,
      profile: null,
      strategy: null,
      detail: 'no_profile',
      // Sélectionnable quand même : l'appareil sera créé en saisie manuelle.
      selectable: true,
      warning: device.capabilities.includes('onoff') ? 'manual' : 'always_on',
      homeyWatts: candidate.homeyWatts,
    };
  }
  // L'ordre est celui de la gravité : « ça ne marchera pas » avant « ça marchera mais ne mesure
  // pas ce que vous croyez » avant « à vérifier ».
  const warning = !device.capabilities.includes('onoff')
    ? 'always_on'
    : !match.supported
    ? 'manual'
    : match.selfUsageOnly
      ? 'self_usage'
      : match.hasSubProfiles
        ? 'sub_profiles'
        : !match.manufacturerConfirmed
          ? 'unconfirmed'
          : null;
  return {
    id: device.id,
    name: device.name,
    zone: device.zoneName,
    deviceClass: device.class,
    profile: match.label,
    strategy: match.strategy,
    detail: match.via,
    selectable: true,
    warning,
    homeyWatts: candidate.homeyWatts,
  };
}
