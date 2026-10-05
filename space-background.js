import * as THREE from './three.module.js';

/*
 * Adapted from the spherical Points / soft star sprite approach in Drei Stars:
 * https://github.com/pmndrs/drei/blob/master/src/core/Stars.tsx
 * https://github.com/pmndrs/drei/blob/master/LICENSE
 *
 * MIT License
 * Copyright (c) 2020 react-spring
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */

const VERTEX_SHADER = /* glsl */ `
  uniform float time;
  uniform float motion;
  uniform float pixelRatio;
  attribute float size;
  attribute float phase;
  attribute float brightness;
  varying vec3 vStarColor;
  varying float vBrightness;

  void main() {
    vStarColor = color;
    float shimmer = sin(time * (0.18 + phase * 0.04) + phase);
    vBrightness = brightness * (1.0 + shimmer * 0.06 * motion);
    vec4 viewPosition = modelViewMatrix * vec4(position, 1.0);
    // Distant stars keep their apparent magnitude when the Moon is zoomed.
    gl_PointSize = max(1.0, size * pixelRatio);
    gl_Position = projectionMatrix * viewPosition;
  }
`;

const FRAGMENT_SHADER = /* glsl */ `
  uniform float opacity;
  varying vec3 vStarColor;
  varying float vBrightness;

  void main() {
    float radius = length(gl_PointCoord - vec2(0.5)) * 2.0;
    if (radius > 1.0) discard;
    float core = exp(-radius * radius * 6.0);
    float halo = 0.10 * exp(-radius * radius * 2.0);
    float edge = 1.0 - smoothstep(0.72, 1.0, radius);
    float alpha = (core + halo) * edge * vBrightness * opacity;
    gl_FragColor = vec4(vStarColor, alpha);
    #include <colorspace_fragment>
  }
`;

function seededRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

function buildLayer({ count, near, far, seed, size, brightness, opacity }, motion) {
  const random = seededRandom(seed);
  const positions = new Float32Array(count * 3);
  const colors = new Float32Array(count * 3);
  const sizes = new Float32Array(count);
  const phases = new Float32Array(count);
  const brightnesses = new Float32Array(count);
  const palette = [
    new THREE.Color('#dce6f1'),
    new THREE.Color('#ebdcc4'),
    new THREE.Color('#becfeb')
  ];

  for (let index = 0; index < count; index++) {
    // Uniform cos(latitude), rather than uniform latitude, avoids polar clusters.
    const vertical = 1 - 2 * random();
    const angle = random() * Math.PI * 2;
    const radius = near + random() * (far - near);
    const horizontal = Math.sqrt(1 - vertical * vertical);
    const offset = index * 3;
    positions[offset] = radius * horizontal * Math.cos(angle);
    positions[offset + 1] = radius * vertical;
    positions[offset + 2] = radius * horizontal * Math.sin(angle);
    const tint = random();
    const color = palette[tint < .76 ? 0 : tint < .9 ? 1 : 2];
    colors[offset] = color.r;
    colors[offset + 1] = color.g;
    colors[offset + 2] = color.b;
    sizes[index] = size[0] + random() * (size[1] - size[0]);
    phases[index] = random() * Math.PI * 2;
    brightnesses[index] = brightness[0] + random() * (brightness[1] - brightness[0]);
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  geometry.setAttribute('size', new THREE.BufferAttribute(sizes, 1));
  geometry.setAttribute('phase', new THREE.BufferAttribute(phases, 1));
  geometry.setAttribute('brightness', new THREE.BufferAttribute(brightnesses, 1));
  geometry.computeBoundingSphere();

  const material = new THREE.ShaderMaterial({
    uniforms: {
      time: { value: 0 },
      motion: { value: motion ? 1 : 0 },
      pixelRatio: { value: 1 },
      opacity: { value: opacity }
    },
    vertexShader: VERTEX_SHADER,
    fragmentShader: FRAGMENT_SHADER,
    transparent: true,
    vertexColors: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    depthTest: true,
    toneMapped: false
  });
  const points = new THREE.Points(geometry, material);
  points.renderOrder = -1;
  points.onBeforeRender = renderer => {
    material.uniforms.pixelRatio.value = renderer.getPixelRatio();
  };
  return points;
}

/**
 * A local, deterministic sky with two draw calls and 3,700 static vertices.
 * Pass the existing MediaQueryList to follow live reduced-motion preferences,
 * or a boolean for a fixed preference. Delta and time are in seconds.
 * Render through the existing scene/camera; no extra resize listener is needed.
 */
export function createSpaceBackground(scene, { reduceMotion = false } = {}) {
  const isReduced = () => typeof reduceMotion === 'boolean' ? reduceMotion : Boolean(reduceMotion?.matches);
  const root = new THREE.Group();
  root.name = 'space-background';
  const layers = [
    buildLayer({
      count: 3100, near: 58, far: 68, seed: 0x4c554e41,
      size: [.8, 1.35], brightness: [.42, .78], opacity: .58
    }, !isReduced()),
    buildLayer({
      count: 600, near: 46, far: 58, seed: 0x53544152,
      size: [1.4, 2.65], brightness: [.65, .98], opacity: .92
    }, !isReduced())
  ];
  layers[0].name = 'distant-stars';
  layers[1].name = 'bright-stars';
  root.add(...layers);
  scene.add(root);
  let elapsed = 0;
  let disposed = false;

  return {
    update(delta, time) {
      if (disposed) return;
      const reduced = isReduced();
      for (const layer of layers) layer.material.uniforms.motion.value = reduced ? 0 : 1;
      if (reduced) return;
      const step = Number.isFinite(delta) ? Math.min(Math.max(delta, 0), .05) : 0;
      if (!step) return;
      elapsed += step;
      const clock = Number.isFinite(time) && time >= 0 ? time : elapsed;
      root.rotation.y += step * .00072;
      root.rotation.x += step * .00014;
      layers[1].rotation.y += step * .00012;
      for (const layer of layers) layer.material.uniforms.time.value = clock;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      root.removeFromParent();
      for (const layer of layers) {
        layer.geometry.dispose();
        layer.material.dispose();
      }
      root.clear();
    }
  };
}
