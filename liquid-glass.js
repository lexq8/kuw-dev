// Independent implementation of the optics described at kube.io/blog/liquid-glass-css-svg/.
// A rounded-rectangle distance field supplies the border normal; Snell's law bends
// the sampled background toward the flat center of a convex squircle bezel.
export function buildRefractionMap({ width, height, radius, bezel = 12, depth = 18 }) {
  const displacement = new Uint8ClampedArray(width * height * 4);
  const highlight = new Uint8ClampedArray(displacement.length);
  const r = Math.min(radius, width / 2, height / 2);
  const edge = Math.min(bezel, r);
  const samples = 128;
  const profile = new Float32Array(samples);
  const surface = t => Math.pow(1 - Math.pow(1 - t, 4), .25);
  let maximum = 0;
  for (let i = 0; i < samples; i++) {
    const t = (i + .5) / samples;
    const low = Math.max(0, t - .001);
    const high = Math.min(1, t + .001);
    const slope = (surface(high) - surface(low)) / (high - low);
    const length = Math.hypot(slope, 1);
    const nx = -slope / length, ny = 1 / length;
    const eta = 1 / 1.5;
    const incidence = -ny;
    const bend = eta * incidence + Math.sqrt(1 - eta * eta * (1 - incidence * incidence));
    const rayX = -bend * nx;
    const rayY = -eta - bend * ny;
    profile[i] = rayX / -rayY * (depth + surface(t) * edge);
    maximum = Math.max(maximum, profile[i]);
  }
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const p = (y * width + x) * 4;
      const px = x + .5 - width / 2, py = y + .5 - height / 2;
      const qx = Math.abs(px) - (width / 2 - r);
      const qy = Math.abs(py) - (height / 2 - r);
      const ox = Math.max(qx, 0), oy = Math.max(qy, 0);
      const outside = Math.hypot(ox, oy);
      const inside = r - outside - Math.min(Math.max(qx, qy), 0);
      let normalX = 0, normalY = 0, amount = 0;
      if (inside >= 0 && inside < edge) {
        if (outside > 0) {
          normalX = ox / outside * Math.sign(px);
          normalY = oy / outside * Math.sign(py);
        } else if (qx > qy) normalX = Math.sign(px);
        else normalY = Math.sign(py);
        amount = profile[Math.min(samples - 1, Math.floor(inside / edge * samples))] / maximum;
        const light = Math.pow(Math.abs(normalX * -.55 + normalY * -.835), 4);
        const rim = Math.exp(-inside / 1.6);
        highlight[p] = highlight[p + 1] = highlight[p + 2] = 255;
        highlight[p + 3] = Math.round(255 * rim * (.08 + light * .3));
      }
      displacement[p] = Math.round(127.5 - normalX * amount * 127.5);
      displacement[p + 1] = Math.round(127.5 - normalY * amount * 127.5);
      displacement[p + 2] = 128;
      displacement[p + 3] = 255;
    }
  }
  // SVG uses (channel - .5) * scale, hence twice the maximum pixel displacement.
  return { width, height, displacement, highlight, scale: maximum * 2 };
}

export function initializeGlassControls(root) {
  const lifecycle = new AbortController();
  const { signal } = lifecycle;
  const ns = 'http://www.w3.org/2000/svg';
  const svgElement = (tag, attributes = {}) => {
    const node = document.createElementNS(ns, tag);
    for (const [name, value] of Object.entries(attributes)) node.setAttribute(name, String(value));
    return node;
  };
  const definitions = svgElement('svg', { width: 0, height: 0, 'aria-hidden': true, focusable: false });
  definitions.classList.add('glass-definitions');
  const defs = svgElement('defs');
  definitions.append(defs);
  document.body.append(definitions);
  // CSS.supports alone accepts url() even in engines that do not render an SVG backdrop.
  const svgBackdrop = /(?:Chrome|Chromium|Edg)\//.test(navigator.userAgent)
    && CSS.supports('backdrop-filter', 'url("#glass")');
  document.documentElement.dataset.glassMode = svgBackdrop ? 'refraction' : 'blur';
  const imageCanvas = document.createElement('canvas');
  const context = imageCanvas.getContext('2d');
  const imageURL = (pixels, width, height) => {
    imageCanvas.width = width;
    imageCanvas.height = height;
    context.putImageData(new ImageData(pixels, width, height), 0, 0);
    return imageCanvas.toDataURL();
  };
  const surfaces = new Map();
  if (svgBackdrop && context) {
    root.querySelectorAll('[data-glass]').forEach((element, index) => {
      const id = `lunar-glass-${index}`;
      const filter = svgElement('filter', { id, filterUnits: 'userSpaceOnUse', primitiveUnits: 'userSpaceOnUse', x: 0, y: 0, 'color-interpolation-filters': 'sRGB' });
      const blur = svgElement('feGaussianBlur', { in: 'SourceGraphic', stdDeviation: element.dataset.glass === 'thumb' ? 0 : .7, result: 'softened' });
      const map = svgElement('feImage', { x: 0, y: 0, result: 'lens-map', preserveAspectRatio: 'none' });
      const displacement = svgElement('feDisplacementMap', { in: 'softened', in2: 'lens-map', xChannelSelector: 'R', yChannelSelector: 'G', result: 'refracted' });
      const shine = svgElement('feImage', { x: 0, y: 0, result: 'shine', preserveAspectRatio: 'none' });
      const blend = svgElement('feBlend', { in: 'refracted', in2: 'shine', mode: 'screen' });
      filter.append(blur, map, displacement, shine, blend);
      defs.append(filter);
      element.style.setProperty('--glass-filter', `url(#${id})`);
      surfaces.set(element, { filter, map, displacement, shine, width: 0, height: 0 });
    });
  }
  let resizeFrame = 0;
  const input = root.querySelector('#sunlight');
  const slider = root.querySelector('.sun-slider');
  const thumb = root.querySelector('.slider-thumb');
  const sync = () => {
    const fraction = Math.max(0, Math.min(1, (Number(input.value) - Number(input.min)) / (Number(input.max) - Number(input.min))));
    const center = 20 + fraction * Math.max(0, input.clientWidth - 40);
    slider.style.setProperty('--thumb-x', `${center}px`);
    slider.style.setProperty('--fill-width', `${center}px`);
  };
  const resize = () => {
    resizeFrame = 0;
    for (const [element, surface] of surfaces) {
      const width = Math.round(element.clientWidth), height = Math.round(element.clientHeight);
      if (!width || !height || (width === surface.width && height === surface.height)) continue;
      const isThumb = element === thumb;
      const pixels = buildRefractionMap({ width, height, radius: height / 2, bezel: isThumb ? 9 : 14, depth: isThumb ? 14 : 20 });
      for (const node of [surface.filter, surface.map, surface.shine]) {
        node.setAttribute('width', width);
        node.setAttribute('height', height);
      }
      surface.map.setAttribute('href', imageURL(pixels.displacement, width, height));
      surface.shine.setAttribute('href', imageURL(pixels.highlight, width, height));
      surface.displacement.setAttribute('scale', pixels.scale.toFixed(2));
      surface.width = width;
      surface.height = height;
    }
    sync();
  };
  const observer = new ResizeObserver(() => {
    if (!resizeFrame) resizeFrame = requestAnimationFrame(resize);
  });
  observer.observe(slider);
  for (const element of surfaces.keys()) observer.observe(element);
  input.addEventListener('input', sync, { signal });
  let keyRelease;
  const releaseSlider = () => {
    slider.classList.remove('is-dragging');
    root.classList.remove('is-adjusting');
  };
  input.addEventListener('pointerdown', () => {
    slider.classList.add('is-dragging');
    root.classList.add('is-adjusting');
  }, { signal });
  window.addEventListener('pointerup', releaseSlider, { signal });
  window.addEventListener('pointercancel', releaseSlider, { signal });
  window.addEventListener('blur', releaseSlider, { signal });
  input.addEventListener('keydown', event => {
    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown'].includes(event.key)) return;
    clearTimeout(keyRelease);
    slider.classList.add('is-dragging');
  }, { signal });
  input.addEventListener('keyup', () => { keyRelease = setTimeout(releaseSlider, 240); }, { signal });
  input.addEventListener('blur', releaseSlider, { signal });
  root.querySelectorAll('button').forEach(button => {
    button.addEventListener('pointermove', event => {
      const rect = button.getBoundingClientRect();
      button.style.setProperty('--glow-x', `${event.clientX - rect.left}px`);
      button.style.setProperty('--glow-y', `${event.clientY - rect.top}px`);
    }, { signal });
  });
  resize();
  return {
    sync,
    dispose() {
      lifecycle.abort();
      observer.disconnect();
      cancelAnimationFrame(resizeFrame);
      clearTimeout(keyRelease);
      definitions.remove();
    }
  };
}
