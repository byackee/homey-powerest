Most of what a home consumes is invisible to Homey. A lamp, a fan, a printer has no meter, so
Homey falls back on a single flat number: the same watts whether a bulb is dimmed to a tenth or
running full. Power Estimator replaces that guess with a measurement. It matches your devices
against the profiles of the PowerCalc library, thousands of readings taken with a wattmeter on
real hardware, and follows the state of each device to work out what it is drawing right now. A
dimmable bulb that Homey counted as a flat 6.5 W turns out to draw 0.9 W at a tenth and 4.5 W at
full brightness.

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
