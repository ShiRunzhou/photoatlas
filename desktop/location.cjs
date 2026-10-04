const fs = require('fs'),
  path = require('path');
let cities;
function countryName(code) {
  if (!code || code === 'UN') return null;
  try {
    return new Intl.DisplayNames(['zh-CN'], { type: 'region' }).of(code);
  } catch {
    return null;
  }
}
function nearest(latitude, longitude, assets) {
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;
  if (!cities) {
    const file = path.join(assets, 'cities.json');
    cities = fs.existsSync(file)
      ? JSON.parse(fs.readFileSync(file, 'utf8'))
      : [];
  }
  const rad = Math.PI / 180;
  let best = null,
    distance = 30;
  for (const city of cities) {
    if (
      Math.abs(city.lat - latitude) > 0.3 ||
      Math.abs(city.lon - longitude) * Math.cos(latitude * rad) > 0.4
    )
      continue;
    const a =
      Math.sin(((city.lat - latitude) * rad) / 2) ** 2 +
      Math.cos(latitude * rad) *
        Math.cos(city.lat * rad) *
        Math.sin(((city.lon - longitude) * rad) / 2) ** 2;
    const km = 6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    if (km < distance) {
      best = city;
      distance = km;
    }
  }
  return best
    ? {
        country: countryName(best.country),
        city: best.name,
        source: 'gps-estimate',
        status: 'known',
        distanceKm: Math.round(distance * 10) / 10,
      }
    : null;
}
module.exports = { countryName, nearest };
