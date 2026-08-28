Homey laat u al een vast vermogen instellen, en voor een waterkoker of een router klopt dat precies
— biedt een apparaat die instelling, gebruik die dan, dat is eenvoudiger dan deze app. Wat één
getal niet kan, is een dimmer volgen. Een lamp op een tiende trekt een fractie van wat zij op vol
trekt, en de kleur verandert het antwoord opnieuw. Power Estimator vervangt dat ene getal door een
meting die het apparaat volgt. Het legt
uw apparaten naast de profielen van de PowerCalc-bibliotheek — duizenden metingen met een
wattmeter op echte apparaten — en volgt de toestand van elk apparaat om te bepalen wat het nu
trekt. Een dimbare lamp die Homey op een vaste 6,5 W zette, blijkt 0,9 W te trekken op een tiende
en 4,5 W op vol.

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
