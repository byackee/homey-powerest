/**
 * `test-runtime/fakes/homey.mts` — l'instance Homey réduite à ce que `runtime/hub.mts` en utilise.
 *
 * Le hub ne touche à Homey que par `HomeyAPI.createAppAPI({ homey })`, qui n'inspecte pas l'objet.
 * Ce faux existe donc surtout pour donner un type au paramètre sans traîner le SDK réel.
 */

import type Homey from 'homey';

export class FakeHomey {
  public readonly timers = new Set<NodeJS.Timeout>();

  public asHomey(): Homey.App['homey'] {
    return this as unknown as Homey.App['homey'];
  }
}
