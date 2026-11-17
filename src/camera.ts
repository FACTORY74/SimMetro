import { PerspectiveCamera, Vector3 } from "three";

export const CAMERA_OFFSET = { x: 37, y: 48, z: 42 } as const;

/** Reserve depth precision for the city as the camera pulls away. The near plane
 * stays at about 3% of the viewing distance, well in front of the ground being viewed. */
export function updateCityCameraDepth(camera: PerspectiveCamera, target: Vector3) {
  const near = Math.max(.5, camera.position.distanceTo(target) / 32);
  if (camera.near === near) return;
  camera.near = near;
  camera.updateProjectionMatrix();
}

export function createCityCamera(size = 100) {
  const camera = new PerspectiveCamera(40, 1, .1, 1500);
  const centre = size / 2;
  camera.position.set(centre + CAMERA_OFFSET.x, CAMERA_OFFSET.y, centre + CAMERA_OFFSET.z);
  camera.lookAt(centre, 0, centre);
  updateCityCameraDepth(camera, new Vector3(centre, 0, centre));
  camera.updateMatrixWorld();
  return camera;
}
