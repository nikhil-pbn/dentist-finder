/** Great-circle distance helpers (server-side ranking, and the distance column). */

const EARTH_RADIUS_METERS = 6_371_008.8;

function toRadians(degrees: number): number {
  return (degrees * Math.PI) / 180;
}

export interface Coordinates {
  latitude: number;
  longitude: number;
}

/** Haversine distance in meters between two WGS84 points. */
export function distanceInMeters(a: Coordinates, b: Coordinates): number {
  const dLat = toRadians(b.latitude - a.latitude);
  const dLon = toRadians(b.longitude - a.longitude);
  const lat1 = toRadians(a.latitude);
  const lat2 = toRadians(b.latitude);

  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.sin(dLon / 2) ** 2 * Math.cos(lat1) * Math.cos(lat2);

  return 2 * EARTH_RADIUS_METERS * Math.asin(Math.min(1, Math.sqrt(h)));
}

export function distanceInKm(a: Coordinates, b: Coordinates): number {
  return distanceInMeters(a, b) / 1000;
}

export function roundKm(km: number, decimals = 2): number {
  const factor = 10 ** decimals;
  return Math.round(km * factor) / factor;
}
