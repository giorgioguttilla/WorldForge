import * as THREE from 'three';

const root = document.querySelector('#app');

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x101418);

const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 100);
camera.position.set(2.4, 1.8, 4);
camera.lookAt(0, 0, 0);

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
root.appendChild(renderer.domElement);

const geometry = new THREE.BoxGeometry(1.4, 1.4, 1.4);
const material = new THREE.MeshStandardMaterial({
  color: 0x6ee7b7,
  roughness: 0.42,
  metalness: 0.18
});
const cube = new THREE.Mesh(geometry, material);
scene.add(cube);

const keyLight = new THREE.DirectionalLight(0xffffff, 2.2);
keyLight.position.set(3, 4, 5);
scene.add(keyLight);

const fillLight = new THREE.HemisphereLight(0x9bdcff, 0x30251c, 1.25);
scene.add(fillLight);

const grid = new THREE.GridHelper(6, 12, 0x39505a, 0x24323a);
grid.position.y = -1.1;
scene.add(grid);

function resizeRenderer() {
  const { clientWidth, clientHeight } = root;
  renderer.setSize(clientWidth, clientHeight, false);
  camera.aspect = clientWidth / clientHeight;
  camera.updateProjectionMatrix();
}

const resizeObserver = new ResizeObserver(resizeRenderer);
resizeObserver.observe(root);
resizeRenderer();

function animate() {
  cube.rotation.x += 0.008;
  cube.rotation.y += 0.012;
  renderer.render(scene, camera);
  requestAnimationFrame(animate);
}

animate();
