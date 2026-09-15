
import {RAD} from "../../util/consts.js";
import * as utc from "../../util/utc.js";
import {regularGrid} from "../../grid/regular.js";
import * as nearest from "../../interpolate/nearest.js";
import * as bilinear from "../../interpolate/bilinear.js";
import {length} from "../../util/math.js";

export function buildWW3PrimaryWaves(file) {
    const epak = file, header = epak.header, vars = header.variables;
    const direction = vars["Primary_wave_direction_surface"];
    const period = vars["Primary_wave_mean_period_surface"];

    // dims are: time,lat,lon
    const time = vars[direction.dimensions[0]];
    const lat = vars[direction.dimensions[1]];
    const lon = vars[direction.dimensions[2]];
    const dirData = epak.blocks[direction.data.block];
    const perData = epak.blocks[period.data.block];
    const data = new Float32Array(dirData.length * 2);

    for (let i = 0; i < dirData.length; i++) {
        const j = i * 2;
        const φ = dirData[i] * RAD;  // wave direction in radians
        const m = perData[i];        // wave period (treated as velocity)
        if (φ === φ && m === m) {
            data[j  ] = -m * Math.sin(φ);
            data[j+1] = -m * Math.cos(φ);
        } else {
            data[j] = data[j+1] = NaN;
        }
    }
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
