Homey laat u al een vermogen instellen voor aan en een voor uit, en interpoleert daartussen met de
dimmer — biedt een apparaat die instellingen, gebruik ze dan, dat is eenvoudiger dan deze app. Wat
die rechte lijn niet kan, is de curve van een echte led volgen, en kleur telt helemaal niet mee.
Een witte spot met 6,5 W van de verpakking, gedimd tot 30 %, wordt geteld als 2,2 W terwijl de
wattmeter 1,2 W leest; een kleurenlamp op vol trekt tussen 1,6 W en 5,3 W afhankelijk van de
gekozen kleur, en geen enkel paar getallen kan dat uitdrukken. Power Estimator vervangt die rechte
lijn door een meting. Het legt uw apparaten naast de profielen van de PowerCalc-bibliotheek —
duizenden metingen met een wattmeter op echte apparaten — en volgt de toestand van elk apparaat,
inclusief helderheid, kleurtemperatuur en tint, om te bepalen wat het nu trekt.

Het aangemaakte apparaat komt niet naast het origineel: het neemt de bediening over. Schakel het
in, dim het, verander de kleur vanaf de nieuwe tegel en de echte lamp volgt, zodat u één apparaat
overhoudt in plaats van twee. Kent de bibliotheek een apparaat niet, of beschrijft het profiel iets
anders — het profiel van een slimme stekker is de stekker, niet de lamp die erin zit — dan voert u
de waarden zelf in, als vaste waarde of als curve die het dimniveau volgt.

Er horen twee dashboardwidgets bij. De ene toont het vermogen van één apparaat. De andere tekent
de hele woning als een stroom, van de hoofdmeter via gebruik en kamer tot elk apparaat, en het
nuttigste getal is dat wat niets anders laat zien: wat de meter ziet en geen enkel apparaat
verklaart.

U hebt een Homey Pro nodig: apparaten van andere apps lezen en aansturen vereist een rechten-set
die Homey Cloud niet biedt. Eén ding is goed om vooraf te weten: Homey staat een app niet toe de
instellingen van een andere app te wijzigen, dus na het toevoegen van een apparaat moet u zelf
"Uitsluiten van Energie" aanvinken op het origineel, anders telt Energie het dubbel. De app
controleert dit en herinnert u eraan tot het gedaan is.

De verbruiksprofielen komen uit het project homeassistant-powercalc van Bram Stroker en zijn
bijdragers, gepubliceerd onder de MIT-licentie. Elk profiel is met een wattmeter op een echt
apparaat gemeten.
