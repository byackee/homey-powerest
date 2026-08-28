Homey permet déjà de fixer une puissance sur un appareil, et pour une bouilloire ou une box c'est
exactement ce qu'il faut — si l'appareil propose ce réglage, utilisez-le, c'est plus simple que
cette app. Ce qu'une valeur unique ne peut pas faire, c'est suivre une gradation. Une ampoule au
dixième de sa luminosité tire une fraction de ce qu'elle tire à fond, et sa couleur change encore
la réponse. Power Estimator remplace ce chiffre unique par une mesure qui suit l'appareil. Il rapproche vos appareils des profils de la bibliothèque PowerCalc — des milliers
de relevés pris au wattmètre sur du vrai matériel — et suit l'état de chacun pour établir ce qu'il
tire à l'instant. Une ampoule gradable que Homey comptait 6,5 W en forfait se révèle tirer 0,9 W
au dixième et 4,5 W à pleine luminosité.

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
