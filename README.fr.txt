Homey permet déjà de fixer une puissance à l'allumage et une à l'extinction, et il interpole entre
les deux selon la gradation — si l'appareil propose ces réglages, utilisez-les, c'est plus simple
que cette app. Ce que cette droite ne sait pas faire, c'est épouser la courbe d'une vraie LED, et
elle ignore complètement la couleur. Un spot blanc réglé à 6,5 W d'après le carton et gradué à
30 % est compté 2,2 W là où le wattmètre lit 1,2 W ; une ampoule couleur à pleine luminosité tire
entre 1,6 W et 5,3 W selon la teinte choisie, et aucun couple de valeurs ne peut exprimer cela.
Power Estimator remplace la droite par une mesure. Il rapproche vos appareils des profils de la
bibliothèque PowerCalc — des milliers de relevés pris au wattmètre sur du vrai matériel — et suit
l'état de chacun, luminosité, température de couleur et teinte comprises, pour établir ce qu'il
tire à l'instant.

L'appareil créé ne s'ajoute pas à l'original : il en reprend les commandes. Allumez-le, graduez-le,
changez sa couleur depuis la nouvelle tuile, la vraie lampe suit — vous gardez un appareil à
utiliser, pas deux. Quand la bibliothèque ne connaît pas un appareil, ou quand son profil décrit
autre chose — le profil d'une prise connectée décrit la prise, pas la lampe branchée dessus — vous
saisissez les valeurs vous-même, en valeur fixe ou en courbe suivant la gradation.

Deux widgets de tableau de bord l'accompagnent. L'un montre la puissance d'un appareil. L'autre
dessine le logement entier en flux, du compteur général jusqu'à chaque appareil en passant par
l'usage et la pièce, et son chiffre le plus utile est celui que rien d'autre ne montre : ce que le
compteur voit et qu'aucun appareil n'explique.

Il faut une Homey Pro : lire et piloter les appareils d'autres apps demande une permission que
Homey Cloud n'offre pas. Une chose mérite d'être sue avant de commencer : Homey n'autorise pas une
app à modifier les réglages d'une autre, donc après avoir ajouté un appareil vous devez cocher
vous-même « Exclure de l'Énergie » sur l'original, faute de quoi l'Énergie le compte deux fois.
L'app le vérifie et vous le rappelle tant que ce n'est pas fait.

Les profils de consommation viennent du projet homeassistant-powercalc de Bram Stroker et de ses
contributeurs, publié sous licence MIT. Chacun a été mesuré au wattmètre sur un appareil réel.
