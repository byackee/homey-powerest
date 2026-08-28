/**
 * `lib/categories.mts` — le regroupement par usage.
 *
 * La vue par pièce répond à « où » ; elle ne répond pas à « à quoi ». Sur un logement réel,
 * savoir que le Salon consomme 3 W n'apprend rien, alors que savoir que l'éclairage pèse 12 %
 * et les veilles 8 % oriente une décision.
 *
 * Le classement se fait sur la `class` Homey, qui existe pour TOUS les appareils, y compris ceux
 * dont la bibliothèque de profils ne sait rien. Les appareils de cette app portent la classe de
 * leur source — `setClass()` à l'initialisation — donc une estimation se range comme la lampe
 * qu'elle estime, et non parmi les capteurs.
 */

export interface Category {
  id: string;
  label: string;
}

export const UNKNOWN_CATEGORY: Category = { id: 'other', label: 'Prises & divers' };

/**
 * Classes Homey rangées par usage.
 *
 * Volontairement peu de catégories : au-delà de six ou sept branches, le diagramme cesse d'être
 * lisible et chaque branche devient trop fine pour porter son nom. Les classes absentes de cette
 * table tombent dans « Prises & divers », ce qui est honnête — on ne sait pas à quoi elles
 * servent — plutôt que de les répartir au jugé.
 */
const BY_CLASS: Readonly<Record<string, Category>> = {
  light: { id: 'light', label: 'Éclairage' },

  tv: { id: 'media', label: 'Multimédia' },
  settopbox: { id: 'media', label: 'Multimédia' },
  speaker: { id: 'media', label: 'Multimédia' },
  amplifier: { id: 'media', label: 'Multimédia' },

  thermostat: { id: 'climate', label: 'Climat & air' },
  heater: { id: 'climate', label: 'Climat & air' },
  fan: { id: 'climate', label: 'Climat & air' },
  airconditioning: { id: 'climate', label: 'Climat & air' },
  airpurifier: { id: 'climate', label: 'Climat & air' },
  airfryer: { id: 'appliance', label: 'Électroménager' },

  washingmachine: { id: 'appliance', label: 'Électroménager' },
  dryer: { id: 'appliance', label: 'Électroménager' },
  dishwasher: { id: 'appliance', label: 'Électroménager' },
  oven: { id: 'appliance', label: 'Électroménager' },
  fridge: { id: 'appliance', label: 'Électroménager' },
  freezer: { id: 'appliance', label: 'Électroménager' },
  coffeemachine: { id: 'appliance', label: 'Électroménager' },
  kettle: { id: 'appliance', label: 'Électroménager' },
  kitchenhood: { id: 'appliance', label: 'Électroménager' },
  vacuumcleaner: { id: 'appliance', label: 'Électroménager' },

  camera: { id: 'security', label: 'Capteurs & sécurité' },
  sensor: { id: 'security', label: 'Capteurs & sécurité' },
  lock: { id: 'security', label: 'Capteurs & sécurité' },
  smokealarm: { id: 'security', label: 'Capteurs & sécurité' },
  homealarm: { id: 'security', label: 'Capteurs & sécurité' },
  doorbell: { id: 'security', label: 'Capteurs & sécurité' },

  socket: UNKNOWN_CATEGORY,
  other: UNKNOWN_CATEGORY,
};

/**
 * `device_type` de la bibliothèque qui l'emportent sur la classe Homey.
 *
 * Une imprimante réseau est déclarée `sensor` par son app — ce qui la rangerait parmi les
 * capteurs de sécurité, absurde pour un appareil qui tire quinze watts. Le profil mesuré, lui,
 * sait ce que c'est.
 */
const BY_DEVICE_TYPE: Readonly<Record<string, Category>> = {
  printer: { id: 'office', label: 'Bureautique & réseau' },
  network: { id: 'office', label: 'Bureautique & réseau' },
  ups: { id: 'office', label: 'Bureautique & réseau' },
  smart_speaker: { id: 'media', label: 'Multimédia' },
  television: { id: 'media', label: 'Multimédia' },
  light: { id: 'light', label: 'Éclairage' },
  fan: { id: 'climate', label: 'Climat & air' },
  heating: { id: 'climate', label: 'Climat & air' },
  vacuum_robot: { id: 'appliance', label: 'Électroménager' },
  camera: { id: 'security', label: 'Capteurs & sécurité' },
};

/** Range un appareil. Le type du profil mesuré l'emporte quand il existe. */
export function categorise(deviceClass: string | null | undefined, deviceType?: string | null): Category {
  if (deviceType) {
    const byType = BY_DEVICE_TYPE[deviceType];
    if (byType) return byType;
  }
  if (deviceClass) {
    const byClass = BY_CLASS[deviceClass];
    if (byClass) return byClass;
  }
  return UNKNOWN_CATEGORY;
}
