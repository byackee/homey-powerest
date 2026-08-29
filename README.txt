Homey already lets you give a device a power figure for on and one for off, and it scales between
those two with the dimmer — if a device offers those settings, use them, it is simpler than this
app. What that straight line cannot do is match the curve of a real LED, and it takes no notice of
colour at all. A white ambiance spot with 6.5 W typed in from the box, dimmed to 30 %, is counted
at 2.2 W where the wattmeter reads 1.2 W; a colour bulb at full brightness draws anywhere between
1.6 W and 5.3 W depending on the hue you chose, and no pair of numbers can express that. Power
Estimator replaces the straight line with a measurement. It matches your devices against the
profiles of the PowerCalc library, thousands of readings taken with a wattmeter on real hardware,
and follows the state of each device — brightness, colour temperature, hue — to work out what it
is drawing right now.

The device it creates does not sit beside the original: it takes over its controls. Switch it on,
dim it, change its colour from the new tile, and the real lamp follows, so you keep one device to
use rather than two. When the library does not know a device, or when its profile describes
something else — a smart plug's profile is the plug, not the lamp plugged into it — you enter the
figures yourself, as a fixed value or as a curve that follows the dimmer.

Two dashboard widgets come with it. One shows the power of a single device. The other draws the
whole home as a flow, from the main meter down through usage and room to each device, and its most
useful number is the one nothing else shows you: what the meter sees and no device explains.

It needs Homey Pro. Reading and driving devices that belong to other apps requires a permission
Homey Cloud does not offer. One thing is worth knowing before you start: Homey does not let an app
change another app's settings, so after adding a device you have to tick "Exclude from Energy" on
the original yourself, otherwise Energy counts it twice. The app checks this and tells you until
it is done.

The consumption profiles come from the homeassistant-powercalc project by Bram Stroker and its
contributors, published under the MIT licence. Each one was measured with a wattmeter on a real
device by a contributor.
