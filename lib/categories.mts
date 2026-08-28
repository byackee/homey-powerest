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
  /**
   * Libellé de repli, en anglais.
   *
   * ⚠️ Ce n'est PAS ce qu'on affiche : la traduction se fait dans `app.mts`, seul endroit où
   * `homey.__` existe. Ce champ ne sert que si une clé de traduction manque — auquel cas un
   * libellé anglais vaut mieux qu'une clé brute à l'écran. Les libellés étaient auparavant écrits
   * en français en dur, et un utilisateur anglais lisait « Éclairage ».
   */
  label: string;
}

export const UNKNOWN_CATEGORY: Category = { id: 'other', label: 'Sockets & other' };

/**
 * Classes Homey rangées par usage.
 *
 * Volontairement peu de catégories : au-delà de six ou sept branches, le diagramme cesse d'être
 * lisible et chaque branche devient trop fine pour porter son nom. Les classes absentes de cette
 * table tombent dans « Prises & divers », ce qui est honnête — on ne sait pas à quoi elles
 * servent — plutôt que de les répartir au jugé.
 */
const BY_CLASS: Readonly<Record<string, Category>> = {
  light: { id: 'light', label: 'Lighting' },

  tv: { id: 'media', label: 'Media' },
  settopbox: { id: 'media', label: 'Media' },
  speaker: { id: 'media', label: 'Media' },
  amplifier: { id: 'media', label: 'Media' },

  thermostat: { id: 'climate', label: 'Climate & air' },
  heater: { id: 'climate', label: 'Climate & air' },
  fan: { id: 'climate', label: 'Climate & air' },
  airconditioning: { id: 'climate', label: 'Climate & air' },
  airpurifier: { id: 'climate', label: 'Climate & air' },
  airfryer: { id: 'appliance', label: 'Appliances' },

  washingmachine: { id: 'appliance', label: 'Appliances' },
  dryer: { id: 'appliance', label: 'Appliances' },
  dishwasher: { id: 'appliance', label: 'Appliances' },
  oven: { id: 'appliance', label: 'Appliances' },
  fridge: { id: 'appliance', label: 'Appliances' },
  freezer: { id: 'appliance', label: 'Appliances' },
  coffeemachine: { id: 'appliance', label: 'Appliances' },
  kettle: { id: 'appliance', label: 'Appliances' },
  kitchenhood: { id: 'appliance', label: 'Appliances' },
  vacuumcleaner: { id: 'appliance', label: 'Appliances' },

  camera: { id: 'security', label: 'Sensors & security' },
  sensor: { id: 'security', label: 'Sensors & security' },
  lock: { id: 'security', label: 'Sensors & security' },
  smokealarm: { id: 'security', label: 'Sensors & security' },
  homealarm: { id: 'security', label: 'Sensors & security' },
  doorbell: { id: 'security', label: 'Sensors & security' },

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
  printer: { id: 'office', label: 'Office & network' },
  network: { id: 'office', label: 'Office & network' },
  ups: { id: 'office', label: 'Office & network' },
  smart_speaker: { id: 'media', label: 'Media' },
  television: { id: 'media', label: 'Media' },
  light: { id: 'light', label: 'Lighting' },
  fan: { id: 'climate', label: 'Climate & air' },
  heating: { id: 'climate', label: 'Climate & air' },
  vacuum_robot: { id: 'appliance', label: 'Appliances' },
  camera: { id: 'security', label: 'Sensors & security' },
};

/**
 * Toutes les catégories proposables, dans l'ordre d'un menu.
 *
 * Sert à la fois au diagramme et à la page de réglages : une seule liste, donc pas de menu qui
 * propose un usage que le modèle ne connaît pas.
 */
export const CATEGORIES: readonly Category[] = [
  { id: 'light', label: 'Lighting' },
  { id: 'appliance', label: 'Appliances' },
  { id: 'media', label: 'Media' },
  { id: 'climate', label: 'Climate & air' },
  { id: 'office', label: 'Office & network' },
  { id: 'security', label: 'Sensors & security' },
  UNKNOWN_CATEGORY,
];

/** La catégorie portant cet identifiant, ou `null` si l'identifiant n'en désigne aucune. */
export function categoryById(id: string | null | undefined): Category | null {
  if (typeof id !== 'string' || id === '') return null;
  return CATEGORIES.find((c) => c.id === id) ?? null;
}

/**
 * Range un appareil.
 *
 * L'ordre de priorité est celui de la certitude : le choix EXPLICITE de l'utilisateur d'abord —
 * lui seul sait ce qui est branché sur une prise —, puis le type du profil mesuré, puis la classe
 * Homey. Sans le premier niveau, un onduleur ou un module encastré resterait à jamais dans
 * « Prises & divers », qui devient alors le plus gros poste du diagramme sans rien apprendre.
 */
export function categorise(
  deviceClass: string | null | undefined,
  deviceType?: string | null,
  override?: string | null,
): Category {
  const chosen = categoryById(override);
  if (chosen) return chosen;
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
