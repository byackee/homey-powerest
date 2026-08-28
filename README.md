# Power Estimator — app Homey

Estime la puissance (`measure_power`) et l'énergie (`meter_power`) des appareils qui n'ont aucun
compteur, à partir de **profils mesurés au wattmètre**.

C'est l'équivalent Homey de [PowerCalc](https://github.com/bramstroker/homeassistant-powercalc)
pour Home Assistant. Rien de comparable n'existait : *Power by the Hour* agrège, tarife et
totalise, mais ne traite que des appareils qui mesurent déjà.

## Le problème

Homey attribue aux appareils non mesurés **une valeur plate** : `energy_value_on` quand ils sont
allumés, `energy_value_off` sinon. Une ampoule graduée à 10 % est comptée comme une ampoule à
fond.

Relevé sur un parc réel de 94 appareils, ampoules Philips Hue en blanc chaud :

| Modèle | Homey allumé | Réel 10 % | 70 % | 100 % |
|--------|-------------:|----------:|-----:|------:|
| LTW013 | 6,5 W | 0,9 | 2,6 | 4,5 |
| LCT012 | 6,0 W | 0,9 | 2,5 | 4,4 |
| LST002 | 20,0 W | 1,3 | 9,7 | 18,5 |

Sur les 23 appareils reconnus de ce parc, allumés à 70 % : **Homey annonce 195 W, la mesure
donne 84 W**.

## Comment ça marche

1. L'app lit l'index public de la bibliothèque PowerCalc (`api.powercalc.nl`, 744 modèles).
2. Elle rapproche chaque appareil Homey d'un profil par son modèle : l'app Hue publie
   `settings.Model_ID = "LCT012"`, qui est exactement la clé Signify de la bibliothèque. La
   jointure est directe, pas heuristique — 23 des 26 appareils estimables d'un parc réel.
3. Vous créez un **appareil qui remplace le vôtre** : il reprend ses commandes (allumage,
   gradation, teinte, saturation, température) et y ajoute `measure_power` et `meter_power`.
4. L'app s'abonne aux changements de la source et recalcule ; les commandes faites sur la nouvelle
   tuile sont renvoyées à l'appareil réel.
5. Vous masquez l'appareil d'origine et ne gardez que celui-ci.
6. Un widget de tableau de bord permet aussi d'afficher la puissance estimée à côté de n'importe
   quel appareil.

Stratégies gérées : `lut` (531 profils), `fixed` (134), `linear` (69) — soit 734 des 744.
`composite` et `multi_switch` (10 profils) ne le sont pas.

## Limites connues, et pourquoi

- 🔴 **`measure_power` ne peut pas être ajouté à l'appareil d'origine.** Aucune API n'ajoute de
  capability à l'appareil d'une autre app : côté appareils il n'y a que `getCapabilityValue` et
  `setCapabilityValue`, qui agissent sur une capability existante, et `updateDevice` ne touche que
  `name`, `zone`, `note`, `iconOverride`, `virtualClass`, `uiIndicator`, `hidden`. Le
  `Device#addCapability()` du SDK ne vaut que pour les appareils de sa propre app. C'est pourquoi
  l'app crée un appareil qui **remplace** le vôtre plutôt qu'un appareil qui s'y ajoute — et c'est
  aussi ce que fait *Device Capabilities*, la référence du store, avec son *Advanced Virtual
  Device*.
- 🔴 **L'exclusion de la source est manuelle.** Homey applique sa propre estimation forfaitaire à
  l'appareil source ; sans l'exclure, l'onglet Énergie compte deux fois le même appareil et le
  total devient *plus* faux qu'avant l'installation. **Une app ne peut pas le faire elle-même** :
  l'opération `setDeviceSettings` demande le scope `homey.device`, et une app — même avec la
  permission `homey:manager:api` — ne reçoit que `homey.device.readonly` et
  `homey.device.control` (`Error: Missing Scopes`, vérifié sur une Homey Pro). La même limite
  condamne l'approche alternative qui aurait consisté à corriger `energy_value_on` de la source à
  la volée. L'app lit donc l'état réel de la source et affiche un avertissement sur l'appareil
  virtuel tant que **Réglages → Énergie → Exclure de l'Énergie** n'est pas coché côté source.
  L'avertissement disparaît tout seul dès que c'est fait.
- **Température de couleur.** Homey expose `light_temperature` dans 0..1 et ne dit jamais quelle
  est la plage physique de la lampe ; les tables sont en mired absolus. L'app suppose 153–500,
  la plage des Philips Hue, et le rend réglable par appareil. C'est la principale source
  d'imprécision sur une lampe d'une autre marque.
- **Profils « consommation propre ».** Le profil d'une prise ou d'un variateur (`smart_switch`,
  `smart_dimmer`, `network`, `ups`, `power_meter` — une centaine de profils) décrit l'appareil,
  **pas la charge qu'il pilote**. Une innr SP 120 vaut 0,6 W, ce qui est la prise et non la lampe
  branchée dessus. L'appairage le signale explicitement.
- **Hors ligne.** Un profil jamais téléchargé ne peut pas être ajouté sans Internet. Ceux déjà
  en cache continuent de fonctionner, y compris après redémarrage.
- **Trous de comptage.** Si l'app est arrêtée plus de 15 minutes, la période n'est pas
  extrapolée : `meter_power` étant monotone, une erreur d'extrapolation serait définitive. Mieux
  vaut un trou qu'un mensonge irréversible.

## Développement

```sh
npm ci
npm run typecheck
npm test                 # 54 tests, dont des tables de mesure réelles en fixture
npm run validate:publish
```

## Crédits

Les profils de consommation viennent du projet
[homeassistant-powercalc](https://github.com/bramstroker/homeassistant-powercalc) de Bram
Stroker et de ses contributeurs, publié sous licence **MIT**. Ils sont téléchargés à l'exécution
depuis `api.powercalc.nl` et mis en cache localement ; rien n'est redistribué avec cette app.
Chaque mesure a été prise au wattmètre sur un appareil réel par un contributeur du projet.
