
import * as utc from "../../util/utc.js";
import {regularGrid} from "../../grid/regular.js";
import * as nearest from "../../interpolate/nearest.js";
import * as bilinear from "../../interpolate/bilinear.js";
import * as legacy from "../legacy.js";
import {merge} from "../../util/arrays.js";
import {length} from "../../util/math.js";

export function buildGFSWind(file) {
    if (Array.isArray(file)) {
        file = legacy.munge(file, ["u", "v"], ["time", "level", "lat", "lon"]);
    }
    const epak = file;
    const {variables: vars} = epak.header;
    const u = vars["U"] || vars["u"] || vars["u-component_of_wind_isobaric"] || vars["u-component_of_wind_height_above_ground"];
    const v = vars["V"] || vars["v"] || vars["v-component_of_wind_isobaric"] || vars["v-component_of_wind_height_above_ground"];

    // dims are: time,level,lat,lon
    const time = vars[u.dimensions[0]];
    const lat = vars[u.dimensions[2]];
    const lon = vars[u.dimensions[3]];
    const data = merge(epak.blocks[u.data.block], epak.blocks[v.data.block]);
    data.containsNaN = false;

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
