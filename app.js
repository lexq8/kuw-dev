import * as THREE from 'three';
import { OrbitControls } from 'three/addons/OrbitControls.js';

const $ = id => document.getElementById(id);
const canvas = $('moon-canvas');
const viewport = $('viewport');
const loading = $('loading');
const toolbar = $('toolbar');
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)');
let renderer, controls, moon, camera, scene, frameId, destroyed = false;
let automaticRotation = !reduceMotion.matches;
let baseDistance = 4.2;
let lastTime = 0;
let ready = false;

function announce(message) { $('status').textContent = message; }
function showError(message) {
  loading.hidden = true;
  $('error-message').textContent = message;
  $('error').hidden = false;
  toolbar.inert = true;
  ready = false;
  if (frameId) cancelAnimationFrame(frameId);
}

$('retry').addEventListener('click', () => location.reload());
window.addEventListener('pagehide', event => {
  if (event.persisted) return;
  destroyed = true;
  cancelAnimationFrame(frameId);
  controls?.dispose();
  renderer?.dispose();
});
canvas.addEventListener('webglcontextlost', event => {
  event.preventDefault();
  showError('توقف العرض ثلاثي الأبعاد مؤقتًا. أعد المحاولة لاستعادة المشهد.');
});

function updateRotation(value) {
  automaticRotation = value;
  if (controls) controls.autoRotate = value;
  $('spin').setAttribute('aria-pressed', String(value));
  $('spin').title = value ? 'إيقاف الدوران التلقائي' : 'تشغيل الدوران التلقائي';
  $('spin-label').textContent = value ? 'إيقاف الدوران' : 'تشغيل الدوران';
  $('pause-icon').toggleAttribute('hidden', !value);
  $('play-icon').toggleAttribute('hidden', value);
}

function updateZoom() {
  if (!controls || !camera) return;
  const distance = camera.position.distanceTo(controls.target);
  $('zoom-level').textContent = (baseDistance / distance).toFixed(1) + '×';
  $('zoom-in').disabled = distance <= controls.minDistance + .01;
  $('zoom-out').disabled = distance >= controls.maxDistance - .01;
}

function zoom(factor) {
  if (!ready) return;
  const offset = camera.position.clone().sub(controls.target);
  const distance = THREE.MathUtils.clamp(offset.length() * factor, controls.minDistance, controls.maxDistance);
  camera.position.copy(controls.target).add(offset.setLength(distance));
  controls.update();
  updateZoom();
}

async function init() {
  try {
    renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, powerPreference: 'default' });
  } catch {
    showError('متصفحك لا يدعم العرض ثلاثي الأبعاد الآن. جرّب Safari أو Chrome مع تفعيل تسريع الرسومات.');
    return;
  }
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.3;
  renderer.setClearColor(0x000000, 0);

  scene = new THREE.Scene();
  camera = new THREE.PerspectiveCamera(36, 1, .1, 100);
  scene.add(camera);
  camera.position.set(0, .15, baseDistance);

  const sunlight = new THREE.DirectionalLight(0xfff9ed, 3.15);
  const sunTarget = new THREE.Object3D();
  sunTarget.position.set(0, 0, -4);
  camera.add(sunTarget);
  camera.add(sunlight);
  sunlight.target = sunTarget;
  scene.add(new THREE.AmbientLight(0xb9c5d8, .035));

  function updateLight() {
    const degrees = Number($('sunlight').value);
    const radians = THREE.MathUtils.degToRad(degrees);
    sunlight.position.set(Math.sin(radians) * 8, 1.4, -4 + Math.cos(radians) * 8);
    $('sun-value').value = (degrees < 0 ? '−' + Math.abs(degrees) : degrees) + '°';
    $('sunlight').setAttribute('aria-valuetext', `${degrees} درجة`);
  }
  $('sunlight').addEventListener('input', updateLight);
  updateLight();

  controls = new OrbitControls(camera, canvas);
  controls.enableDamping = true;
  controls.dampingFactor = .065;
  controls.enablePan = false;
  controls.rotateSpeed = .5;
  controls.zoomSpeed = .55;
  controls.minDistance = 1.65;
  controls.maxDistance = 7;
  controls.autoRotateSpeed = .32;
  controls.enableKeys = false;
  updateRotation(automaticRotation);
  controls.addEventListener('change', updateZoom);
  controls.addEventListener('start', () => {
    if (automaticRotation) updateRotation(false);
  });
  $('spin').addEventListener('click', () => updateRotation(!automaticRotation));
  $('zoom-in').addEventListener('click', () => zoom(.84));
  $('zoom-out').addEventListener('click', () => zoom(1 / .84));
  $('reset').addEventListener('click', () => {
    controls.reset();
    camera.position.set(0, .10, baseDistance);
    controls.update();
    $('sunlight').value = '-35';
    updateLight();
    updateRotation(!reduceMotion.matches);
    updateZoom();
    announce('تمت إعادة المشهد.');
  });
  reduceMotion.addEventListener('change', event => { if (event.matches) updateRotation(false); });

  canvas.addEventListener('keydown', event => {
    if (!ready) return;
    const key = event.key;
    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', '+', '=', '-', '_', ' ', 'Home'].includes(key)) return;
    event.preventDefault();
    if (['+', '='].includes(key)) return zoom(.9);
    if (['-', '_'].includes(key)) return zoom(1 / .9);
    if (key === ' ') return updateRotation(!automaticRotation);
    if (key === 'Home') return $('reset').click();
    updateRotation(false);
    const offset = camera.position.clone().sub(controls.target);
    const spherical = new THREE.Spherical().setFromVector3(offset);
    if (key === 'ArrowLeft') spherical.theta -= .085;
    if (key === 'ArrowRight') spherical.theta += .085;
    if (key === 'ArrowUp') spherical.phi -= .085;
    if (key === 'ArrowDown') spherical.phi += .085;
    spherical.makeSafe();
    camera.position.copy(controls.target).add(new THREE.Vector3().setFromSpherical(spherical));
    controls.update();
  });

  let firstSize = true;
  const resize = () => {
    if (destroyed) return;
    const width = viewport.clientWidth;
    const height = viewport.clientHeight;
    renderer.setSize(width, height, false);
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
    const oldBaseDistance = baseDistance;
    const relativeDistance = camera.position.distanceTo(controls.target) / oldBaseDistance;
    const verticalFov = THREE.MathUtils.degToRad(camera.fov);
    const limitingHalfFov = Math.min(verticalFov / 2, Math.atan(Math.tan(verticalFov / 2) * camera.aspect));
    baseDistance = 1.22 / Math.sin(limitingHalfFov);
    controls.maxDistance = Math.max(baseDistance * 1.65, 7);
    if (firstSize) {
      camera.position.set(0, .10, baseDistance);
      controls.update();
      controls.saveState();
      firstSize = false;
    } else {
      const offset = camera.position.clone().sub(controls.target);
      const distance = THREE.MathUtils.clamp(baseDistance * relativeDistance, controls.minDistance, controls.maxDistance);
      camera.position.copy(controls.target).add(offset.setLength(distance));
      controls.update();
    }
    updateZoom();
  };
  const observer = new ResizeObserver(resize);
  observer.observe(viewport);
  resize();

  const textureLoader = new THREE.TextureLoader();
  try {
    const [color, bump] = await Promise.all([
      textureLoader.loadAsync('./assets/moon-color-2k.jpg'),
      textureLoader.loadAsync('./assets/moon-bump-2k.png')
    ]);
    if (destroyed) { color.dispose(); bump.dispose(); return; }
    color.colorSpace = THREE.SRGBColorSpace;
    color.wrapS = THREE.RepeatWrapping;
    bump.wrapS = THREE.RepeatWrapping;
    color.anisotropy = Math.min(renderer.capabilities.getMaxAnisotropy(), 8);
    bump.anisotropy = color.anisotropy;
    const geometry = new THREE.SphereGeometry(1, 192, 128);
    const material = new THREE.MeshStandardMaterial({
      map: color, bumpMap: bump, bumpScale: .017, roughness: 1, metalness: 0
    });
    moon = new THREE.Mesh(geometry, material);
    // NASA's equirectangular maps are centered on 0° longitude (the near side).
    moon.rotation.set(0, -Math.PI / 2, THREE.MathUtils.degToRad(6));
    scene.add(moon);
    ready = true;
    toolbar.inert = false;
    renderer.render(scene, camera);
    canvas.classList.add('is-ready');
    loading.classList.add('is-finished');
    setTimeout(() => { loading.hidden = true; }, 400);
    announce('القمر جاهز للاستكشاف.');
    document.documentElement.dataset.moonReady = 'true';

    const modelContext = document.modelContext;
    if (modelContext?.registerTool) {
      const lifecycle = new AbortController();
      window.addEventListener('pagehide', event => { if (!event.persisted) lifecycle.abort(); });
      try {
        Promise.resolve(modelContext.registerTool({
          name: 'set_moon_controls',
          title: 'ضبط مشهد القمر',
          description: 'Change the visible Moon sunlight angle and automatic rotation. Only affects this page; does not save or publish anything.',
          inputSchema: {
            type: 'object',
            properties: { sunlight_degrees: { type: 'number', minimum: -155, maximum: 155 }, rotating: { type: 'boolean' } },
            required: ['sunlight_degrees', 'rotating'], additionalProperties: false
          },
          annotations: { readOnlyHint: false, untrustedContentHint: false },
          execute(input) {
            if (!ready || !input || !Number.isFinite(input.sunlight_degrees) || input.sunlight_degrees < -155 || input.sunlight_degrees > 155 || typeof input.rotating !== 'boolean') {
              throw new Error('Expected sunlight_degrees between -155 and 155 and a boolean rotating value.');
            }
            $('sunlight').value = String(Math.round(input.sunlight_degrees));
            updateLight();
            updateRotation(input.rotating);
            return { sunlight_degrees: Number($('sunlight').value), rotating: automaticRotation };
          }
        }, { signal: lifecycle.signal })).catch(() => {});
      } catch { /* Optional browser integration; the visible controls remain available. */ }
    }

    // Upgrade detail after the first view. Failure leaves the complete 2K view usable.
    if (renderer.capabilities.maxTextureSize >= 4096 && !navigator.connection?.saveData) {
      textureLoader.load('./assets/moon-color-4k.jpg', detailed => {
        if (destroyed) { detailed.dispose(); return; }
        detailed.colorSpace = THREE.SRGBColorSpace;
        detailed.wrapS = THREE.RepeatWrapping;
        detailed.anisotropy = color.anisotropy;
        material.map = detailed;
        material.needsUpdate = true;
        color.dispose();
        document.documentElement.dataset.moonQuality = '4k';
      }, undefined, () => { document.documentElement.dataset.moonQuality = '2k'; });
    }
    function animate(time) {
      if (destroyed || !ready) return;
      const delta = Math.min((time - lastTime) / 1000, .05);
      lastTime = time;
      if (!document.hidden) {
        controls.update(delta);
        renderer.render(scene, camera);
      }
      frameId = requestAnimationFrame(animate);
    }
    frameId = requestAnimationFrame(animate);
  } catch {
    showError('لم نتمكن من تحميل خرائط القمر. أعد المحاولة بعد اكتمال تشغيل المعاينة.');
  }
}

init().catch(() => showError('حدث خطأ في تحميل المشهد. أعد المحاولة.'));
