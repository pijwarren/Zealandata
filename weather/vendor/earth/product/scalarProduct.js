
import {isFunction, last} from "../lib/underscore.js";
import * as utc from "../util/utc.js";
import * as legacy from "./legacy.js";
import {regularGrid} from "../grid/regular.js";
import * as nearest from "../interpolate/nearest.js";
import * as bilinear from "../interpolate/bilinear.js";

export function scalarProduct(bundle, selector, options = {}) {
    // Assumes dimension structure of: [time, ..., lat, lon]
    if (Array.isArray(bundle)) {
        bundle = legacy.munge(bundle, [options.legacyName]);
    }
    if (!bundle.blocks) {
        bundle = legacy.blockify(bundle, selector);
    }
    const epak = bundle;
    const {variables: vars} = epak.header;
    const x = Object.keys(vars).find(e => selector.test(e));
    const target = vars[x];
    const dims = target.dimensions;
    const time = vars[dims[0]];
    const lat = vars[last(dims, 2)[0]];
    const lon = vars[last(dims, 2)[1]];
    const data = epak.blocks[target.data.block];
    data.containsNaN = options.hasMissing;

    if (isFunction(options.transform)) {
        options.transform(data);
    }

    const grid = regularGrid(lon.sequence, lat.sequence);
    const field = {
        valueAt: i => data[i],
        scalarize: x => x,
        isDefined: i => !isNaN(data[i]),
        nearest: nearest.scalar(grid, data),
        bilinear: bilinear.scalar(grid, data),
    };

    return {
        validTime: () => utc.parts(time.data[0]),
        grid: () => grid,
        field: () => field,
        valueInRange(t) { return this.scale.valueInRange(t); },
    };
}
