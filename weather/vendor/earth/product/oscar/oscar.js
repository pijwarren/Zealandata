/* Trimmed from cambecc/earth's product/oscar/oscar.js -- only buildOscar,
   the actual epak decoder, is vendored here. The original file's other
   exports (createCurrentsLayer etc.) are the interactive-app "product"
   wrapper (descriptions, palettes, navigation) and pull in several more
   modules (network/fetcher.js, product/productUtils.js, ux/translations.js,
   product/sources.js, palette/currents.js) that add nothing for a
   headless fetch script -- see weather/fetch_currents.mjs, which
   reimplements the tiny "find latest catalog entry" lookup directly
   instead of vendoring all of that for it. */

import {merge} from "../../util/arrays.js";
import {regularGrid} from "../../grid/regular.js";
import * as nearest from "../../interpolate/nearest.js";
import * as bilinear from "../../interpolate/bilinear.js";
import {length} from "../../util/math.js";
import * as utc from "../../util/utc.js";

export function buildOscar(file) {
    const epak = file, header = epak.header, vars = header.variables;
    const u = vars["u"];
    const v = vars["v"];

    // dims are: time,depth,lat,lon
    const time = vars[u.dimensions[0]];
    const lat = vars[u.dimensions[2]];
    const lon = vars[u.dimensions[3]];
    const data = merge(epak.blocks[u.data.block], epak.blocks[v.data.block]);
    data.containsNaN = true;

    const grid = regularGrid(lon.sequence, lat.sequence);
    const field = {
        valueAt: i => {
            const j = i * 2;
            const u = data[j  ];
            const v = data[j+1];
            return [u, v];
        },
        scalarize: length,
        isDefined: i => !isNaN(data[i * 2]),
        nearest: nearest.vector(grid, data),
        bilinear: bilinear.vector(grid, data),
    };

    return {
        validTime: () => utc.parts(time.data[0]),
        grid: () => grid,
        field: () => field,
        valueInRange(t) { return [this.scale.valueInRange(t), 0]; },
    };
}
