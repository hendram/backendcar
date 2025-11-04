// routesDataLoader.js
import * as routes from "./routesData.js";

/**
 * Dynamically scans and returns all carXPlaces variables
 * exported from routesData.js
 *
 * Example output:
 * {
 *   car1: [...],
 *   car2: [...],
 *   car3: [...]
 * }
 */
export function loadCarPlaces() {
  const cars = {};

  for (const [key, value] of Object.entries(routes)) {
    // match variables like car1Places, car2Places, etc.
    const match = key.match(/^car(\d+)Places$/);
    if (match) {
      const carId = `car${match[1]}`;
      cars[carId] = value;
    }
  }

  return cars;
}
