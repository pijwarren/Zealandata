The files in this directory are a small subset of the decode/interpolation
code from https://github.com/cambecc/earth (the engine behind
earth.nullschool.net), extracted from that site's own published source map
(`bundle.a25d92.js.map`) rather than the upstream repo directly, since the
repo itself lags behind what's actually deployed. They are otherwise
unmodified except for two small import removals noted inline
(`interpolate/nearest.js`, `interpolate/bilinear.js` no longer import a
`lookup.js` helper that isn't needed for the functions this project uses).

Used here to decode NOAA GFS wind data for `weather/fetch_wind.mjs`. See
../README.md for how that fits together.

The MIT License (MIT)

Copyright (c) 2014 Cameron Beccario

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.
