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
      if (!candidate.match) throw new Error(this.homey.__('pair.no_profile'));
      if (!candidate.match.supported) throw new Error(this.homey.__('pair.unsupported'));

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
          manufacturer: candidate.match.manufacturer,
          model: candidate.match.model,
        },
        settings: {
          source_name: `${candidate.device.name}${candidate.device.zoneName ? ` — ${candidate.device.zoneName}` : ''}`,
          profile_label: candidate.match.label,
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
      selectable: false,
      warning: null,
    };
  }
  // L'ordre est celui de la gravité : « ça ne marchera pas » avant « ça marchera mais ne mesure
  // pas ce que vous croyez » avant « à vérifier ».
  const warning = !match.supported
    ? 'unsupported'
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
    selectable: match.supported,
    warning,
  };
}
