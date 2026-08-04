const fullscreenBtn = document.getElementById('fullscreenBtn');
const wireframeBtn = document.getElementById('wireframeBtn');
const figureContainer = document.getElementById('figureContainer');
const iterValue = document.getElementById('iterValue');
const iterSlider = document.getElementById('iterSlider');

let isWireframe = false;
wireframeBtn.addEventListener('click', () => {
  isWireframe = !isWireframe;
  wireframeBtn.classList.toggle('active', isWireframe);
});

function isFS() {
  return !!(
    document.fullscreenElement ||
    document.webkitFullscreenElement ||
    figureContainer.classList.contains('is-fullscreen')
  );
}

function updateFullscreenBtn() {
  fullscreenBtn.textContent = isFS() ? 'Exit Full Screen' : 'Full Screen';
}

fullscreenBtn.addEventListener('click', () => {
  if (isFS()) {
    if (document.exitFullscreen) {
      document.exitFullscreen().catch(() => { });
    } else if (document.webkitExitFullscreen) {
      document.webkitExitFullscreen();
    }
    figureContainer.classList.remove('is-fullscreen');
    updateFullscreenBtn();
  } else {
    const reqFS = figureContainer.requestFullscreen || figureContainer.webkitRequestFullscreen;
    if (reqFS) {
      reqFS.call(figureContainer).catch(() => {
        figureContainer.classList.add('is-fullscreen');
        updateFullscreenBtn();
      });
    } else {
      figureContainer.classList.add('is-fullscreen');
      updateFullscreenBtn();
    }
  }
});

['fullscreenchange', 'webkitfullscreenchange'].forEach(evt => {
  document.addEventListener(evt, () => {
    const active = !!(document.fullscreenElement || document.webkitFullscreenElement);
    if (!active) {
      figureContainer.classList.remove('is-fullscreen');
    }
    updateFullscreenBtn();
  });
});

async function init() {
  if (!navigator.gpu) {
    document.getElementById('error-msg').style.display = 'block';
    document.getElementById('gpuCanvas').style.display = 'none';
    return;
  }

  const canvas = document.getElementById('gpuCanvas');
  const adapter = await navigator.gpu.requestAdapter();
  if (!adapter) {
    document.getElementById('error-msg').style.display = 'block';
    return;
  }

  const device = await adapter.requestDevice();
  const context = canvas.getContext('webgpu');
  const presentationFormat = navigator.gpu.getPreferredCanvasFormat();

  context.configure({
    device,
    format: presentationFormat,
    alphaMode: 'premultiplied',
  });

  const isTouchDevice = ('ontouchstart' in window) || (navigator.maxTouchPoints > 0);
  const isMobile = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent) || (isTouchDevice && Math.min(window.screen.width, window.screen.height) < 1024);

  let fractalIterations = isMobile ? 6 : 7;
  const maxDPR = isMobile ? 1.5 : 2.0;

  iterSlider.value = fractalIterations;
  iterValue.textContent = fractalIterations;

  const wireframeLineWidth = 2.0;
  const initialZoomVal = 2 * Math.sqrt(3);

  // --- WGSL SHADERS ---
  const sharedWgsl = `
    struct Uniforms {
        resolution: vec2<f32>,
        dragRot: vec2<f32>,
        zoom: f32,
        theta: f32,
        isDarkMode: f32,
        lineWidth: f32,
        iterations: f32,
        pad1: f32,
        pad2: vec2<f32>,
    }
    @group(0) @binding(0) var<uniform> uniforms: Uniforms;

    fn rot(a: f32) -> mat2x2<f32> {
        let s = sin(a);
        let c = cos(a);
        return mat2x2<f32>(c, -s, s, c);
    }

    fn getBaseMatrix(theta: f32) -> mat3x3<f32> {
        let c = cos(theta);
        let s = sin(theta);
        return mat3x3<f32>(
            vec3<f32>(-s,  c, 0.0),
            vec3<f32>( 0.0, 0.0, 1.0),
            vec3<f32>( c,  s, 0.0)
        );
    }
  `;

  const meshWgsl = sharedWgsl + `
    struct VertexOutput {
        @builtin(position) position: vec4<f32>,
        @location(0) normal: vec3<f32>,
    };

    @vertex
    fn vs_main(@location(0) pos: vec3<f32>, @location(1) norm: vec3<f32>) -> VertexOutput {
        let baseMat = getBaseMatrix(uniforms.theta);
        let invBaseMat = mat3x3<f32>(
            vec3<f32>(baseMat[0][0], baseMat[1][0], baseMat[2][0]),
            vec3<f32>(baseMat[0][1], baseMat[1][1], baseMat[2][1]),
            vec3<f32>(baseMat[0][2], baseMat[1][2], baseMat[2][2])
        );
        var p_cam = invBaseMat * pos;
        var n_cam = invBaseMat * norm;

        let rotY_inv = rot(-uniforms.dragRot.y);
        let xz_unrot = rotY_inv * vec2<f32>(p_cam.x, p_cam.z);
        p_cam.x = xz_unrot.x;
        p_cam.z = xz_unrot.y;
        
        let n_xz = rotY_inv * vec2<f32>(n_cam.x, n_cam.z);
        n_cam.x = n_xz.x;
        n_cam.z = n_xz.y;

        let rotX_inv2 = rot(-uniforms.dragRot.x);
        let yz_unrot = rotX_inv2 * vec2<f32>(p_cam.y, p_cam.z);
        p_cam.y = yz_unrot.x;
        p_cam.z = yz_unrot.y;
        
        let n_yz = rotX_inv2 * vec2<f32>(n_cam.y, n_cam.z);
        n_cam.y = n_yz.x;
        n_cam.z = n_yz.y;

        let min_res = min(uniforms.resolution.x, uniforms.resolution.y);
        let clip_x = (2.0 * p_cam.x / uniforms.zoom) * (min_res / uniforms.resolution.x);
        let clip_y = -(2.0 * p_cam.y / uniforms.zoom) * (min_res / uniforms.resolution.y);
        let clip_z = p_cam.z * 0.1 + 0.5;

        var out: VertexOutput;
        out.position = vec4<f32>(clip_x, clip_y, clip_z, 1.0);
        out.normal = n_cam;
        return out;
    }

    @fragment
    fn fs_main(in: VertexOutput) -> @location(0) vec4<f32> {
        let n = normalize(in.normal);
        let lightDir = normalize(vec3<f32>(1.0, 2.0, -2.0));
        let viewDir = vec3<f32>(0.0, 0.0, 1.0);
        
        var finalN = n;
        if (dot(n, viewDir) < 0.0) {
            finalN = -n;
        }

        let diff = max(dot(finalN, lightDir), 0.0);
        let baseColor = vec3<f32>(0.85, 0.5, 0.15);
        let color = baseColor * (diff * 0.6 + 0.4);

        return vec4<f32>(color, 1.0);
    }
  `;

  const wireframeWgsl = sharedWgsl + `
    @vertex
    fn vs_main(@location(0) pos: vec3<f32>, @builtin(instance_index) instanceIdx: u32) -> @builtin(position) vec4<f32> {
        let baseMat = getBaseMatrix(uniforms.theta);
        let invBaseMat = mat3x3<f32>(
            vec3<f32>(baseMat[0][0], baseMat[1][0], baseMat[2][0]),
            vec3<f32>(baseMat[0][1], baseMat[1][1], baseMat[2][1]),
            vec3<f32>(baseMat[0][2], baseMat[1][2], baseMat[2][2])
        );
        var p_cam = invBaseMat * pos;

        let rotY_inv = rot(-uniforms.dragRot.y);
        let xz_unrot = rotY_inv * vec2<f32>(p_cam.x, p_cam.z);
        p_cam.x = xz_unrot.x;
        p_cam.z = xz_unrot.y;

        let rotX_inv2 = rot(-uniforms.dragRot.x);
        let yz_unrot = rotX_inv2 * vec2<f32>(p_cam.y, p_cam.z);
        p_cam.y = yz_unrot.x;
        p_cam.z = yz_unrot.y;

        let min_res = min(uniforms.resolution.x, uniforms.resolution.y);
        var clip_x = (2.0 * p_cam.x / uniforms.zoom) * (min_res / uniforms.resolution.x);
        var clip_y = -(2.0 * p_cam.y / uniforms.zoom) * (min_res / uniforms.resolution.y);
        let clip_z = p_cam.z * 0.1 + 0.5;

        let widthScale = max(1.0, uniforms.lineWidth);
        let numSide = u32(ceil(widthScale));
        if (numSide > 1u) {
            let stepX = f32(instanceIdx % numSide) - f32(numSide - 1u) * 0.5;
            let stepY = f32(instanceIdx / numSide) - f32(numSide - 1u) * 0.5;
            clip_x += (stepX * 0.75) * (2.0 / uniforms.resolution.x);
            clip_y += (stepY * 0.75) * (2.0 / uniforms.resolution.y);
        }

        return vec4<f32>(clip_x, clip_y, clip_z, 1.0);
    }

    @fragment
    fn fs_main() -> @location(0) vec4<f32> {
        if (uniforms.isDarkMode < 0.5) {
            return vec4<f32>(0.2, 0.4, 0.8, 0.3);
        }
        return vec4<f32>(0.85, 0.5, 0.15, 0.3);
    }
  `;

  const meshShader = device.createShaderModule({ code: meshWgsl });
  const meshPipeline = device.createRenderPipeline({
    layout: 'auto',
    vertex: {
      module: meshShader,
      entryPoint: 'vs_main',
      buffers: [{
        arrayStride: 24,
        attributes: [
          { shaderLocation: 0, offset: 0, format: 'float32x3' },
          { shaderLocation: 1, offset: 12, format: 'float32x3' }
        ]
      }]
    },
    fragment: {
      module: meshShader,
      entryPoint: 'fs_main',
      targets: [{ format: presentationFormat }],
    },
    primitive: {
      topology: 'triangle-list',
      cullMode: 'none',
    },
    depthStencil: {
      depthWriteEnabled: true,
      depthCompare: 'less',
      format: 'depth24plus',
    },
  });

  const wireframeShader = device.createShaderModule({ code: wireframeWgsl });
  const wireframePipeline = device.createRenderPipeline({
    layout: 'auto',
    vertex: {
      module: wireframeShader,
      entryPoint: 'vs_main',
      buffers: [{
        arrayStride: 12,
        attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x3' }]
      }]
    },
    fragment: {
      module: wireframeShader,
      entryPoint: 'fs_main',
      targets: [{
        format: presentationFormat,
        blend: {
          color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha', operation: 'add' },
          alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
        }
      }],
    },
    primitive: { topology: 'line-list' },
    depthStencil: {
      depthWriteEnabled: false,
      depthCompare: 'always',
      format: 'depth24plus',
    },
  });

  const uniformBuffer = device.createBuffer({
    size: 48,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });
  const uniformData = new Float32Array(12);

  const meshBindGroup = device.createBindGroup({
    layout: meshPipeline.getBindGroupLayout(0),
    entries: [{ binding: 0, resource: { buffer: uniformBuffer } }]
  });

  const wireframeBindGroup = device.createBindGroup({
    layout: wireframePipeline.getBindGroupLayout(0),
    entries: [{ binding: 0, resource: { buffer: uniformBuffer } }]
  });

  let vertexBuffer = null;
  let lineBuffer = null;
  let numVertices = 0;
  let numLines = 0;

  function updateBuffers() {
    let solidDepth = Math.min(fractalIterations, 8); // Cap for safety
    let wireframeDepth = Math.min(fractalIterations, 7);

    // Generate Solid
    const meshData = [];
    function addTriangle(a, b, c) {
      const ab = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
      const ac = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
      let nx = ab[1] * ac[2] - ab[2] * ac[1];
      let ny = ab[2] * ac[0] - ab[0] * ac[2];
      let nz = ab[0] * ac[1] - ab[1] * ac[0];
      const len = Math.hypot(nx, ny, nz);
      if (len > 0) { nx /= len; ny /= len; nz /= len; }
      meshData.push(...a, nx, ny, nz);
      meshData.push(...b, nx, ny, nz);
      meshData.push(...c, nx, ny, nz);
    }

    function genSierpinskiMesh(v0, v1, v2, v3, depth) {
      if (depth === 0) {
        addTriangle(v0, v1, v2);
        addTriangle(v0, v3, v1);
        addTriangle(v0, v2, v3);
        addTriangle(v1, v3, v2);
        return;
      }
      const m01 = [(v0[0] + v1[0]) / 2, (v0[1] + v1[1]) / 2, (v0[2] + v1[2]) / 2];
      const m02 = [(v0[0] + v2[0]) / 2, (v0[1] + v2[1]) / 2, (v0[2] + v2[2]) / 2];
      const m03 = [(v0[0] + v3[0]) / 2, (v0[1] + v3[1]) / 2, (v0[2] + v3[2]) / 2];
      const m12 = [(v1[0] + v2[0]) / 2, (v1[1] + v2[1]) / 2, (v1[2] + v2[2]) / 2];
      const m13 = [(v1[0] + v3[0]) / 2, (v1[1] + v3[1]) / 2, (v1[2] + v3[2]) / 2];
      const m23 = [(v2[0] + v3[0]) / 2, (v2[1] + v3[1]) / 2, (v2[2] + v3[2]) / 2];

      genSierpinskiMesh(v0, m01, m02, m03, depth - 1);
      genSierpinskiMesh(m01, v1, m12, m13, depth - 1);
      genSierpinskiMesh(m02, m12, v2, m23, depth - 1);
      genSierpinskiMesh(m03, m13, m23, v3, depth - 1);
    }

    // Generate Wireframe
    const linesData = [];
    function addLine(p1, p2) {
      linesData.push(...p1, ...p2);
    }
    function genSierpinskiLines(v0, v1, v2, v3, depth) {
      if (depth === 0) {
        addLine(v0, v1); addLine(v1, v2); addLine(v2, v0);
        addLine(v0, v3); addLine(v1, v3); addLine(v2, v3);
        return;
      }
      const m01 = [(v0[0] + v1[0]) / 2, (v0[1] + v1[1]) / 2, (v0[2] + v1[2]) / 2];
      const m02 = [(v0[0] + v2[0]) / 2, (v0[1] + v2[1]) / 2, (v0[2] + v2[2]) / 2];
      const m03 = [(v0[0] + v3[0]) / 2, (v0[1] + v3[1]) / 2, (v0[2] + v3[2]) / 2];
      const m12 = [(v1[0] + v2[0]) / 2, (v1[1] + v2[1]) / 2, (v1[2] + v2[2]) / 2];
      const m13 = [(v1[0] + v3[0]) / 2, (v1[1] + v3[1]) / 2, (v1[2] + v3[2]) / 2];
      const m23 = [(v2[0] + v3[0]) / 2, (v2[1] + v3[1]) / 2, (v2[2] + v3[2]) / 2];

      genSierpinskiLines(v0, m01, m02, m03, depth - 1);
      genSierpinskiLines(m01, v1, m12, m13, depth - 1);
      genSierpinskiLines(m02, m12, v2, m23, depth - 1);
      genSierpinskiLines(m03, m13, m23, v3, depth - 1);
    }

    const p0 = [1, 1, 1];
    const p1 = [-1, -1, 1];
    const p2 = [1, -1, -1];
    const p3 = [-1, 1, -1];
    
    genSierpinskiMesh(p0, p1, p2, p3, solidDepth);
    genSierpinskiLines(p0, p1, p2, p3, wireframeDepth);

    if (vertexBuffer) vertexBuffer.destroy();
    if (lineBuffer) lineBuffer.destroy();

    vertexBuffer = device.createBuffer({
      size: meshData.length * 4,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    });
    device.queue.writeBuffer(vertexBuffer, 0, new Float32Array(meshData));
    numVertices = meshData.length / 6;

    lineBuffer = device.createBuffer({
      size: linesData.length * 4,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    });
    device.queue.writeBuffer(lineBuffer, 0, new Float32Array(linesData));
    numLines = linesData.length / 3;
  }

  updateBuffers();

  iterSlider.addEventListener('input', (e) => {
    fractalIterations = parseInt(e.target.value);
    iterValue.textContent = fractalIterations;
    updateBuffers();
  });

  // --- INTERACTIVE STATE ---
  let targetDragRotX = 0.0;
  let targetDragRotY = 0.0;
  let currentDragRotX = 0.0;
  let currentDragRotY = 0.0;

  let velX = 0;
  let velY = 0;

  let targetZoom = initialZoomVal;
  let currentZoom = initialZoomVal;

  let isDragging = false;
  let lastPointerX = 0;
  let lastPointerY = 0;
  let initialPinchDist = null;
  let initialPinchZoom = initialZoomVal;

  let isHovering = false;
  let hasBeenDragged = false;
  let lockedTheta = Math.PI / 4;
  let currentTheta = Math.PI / 4;
  let lastScrollTheta = Math.PI / 4;

  figureContainer.addEventListener('pointerenter', () => {
    isHovering = true;
    if (hasBeenDragged) {
      lockedTheta = currentTheta;
    }
  });
  figureContainer.addEventListener('pointerleave', (e) => {
    isHovering = false;
    stopDrag(e);
  });

  const darkModeQuery = window.matchMedia('(prefers-color-scheme: dark)');
  let isDarkMode = darkModeQuery.matches ? 1.0 : 0.0;
  darkModeQuery.addEventListener('change', (e) => {
    isDarkMode = e.matches ? 1.0 : 0.0;
  });

  canvas.addEventListener('pointerdown', (e) => {
    const isTouch = e.pointerType === 'touch' || e.pointerType === 'pen';
    if (isTouch && !isFS()) {
      return;
    }
    isDragging = true;
    lastPointerX = e.clientX;
    lastPointerY = e.clientY;
    velX = 0;
    velY = 0;
    try { canvas.setPointerCapture(e.pointerId); } catch (_) { }
  });

  canvas.addEventListener('pointermove', (e) => {
    if (!isDragging) return;
    const dx = e.clientX - lastPointerX;
    const dy = e.clientY - lastPointerY;
    lastPointerX = e.clientX;
    lastPointerY = e.clientY;

    if (Math.abs(dx) > 0 || Math.abs(dy) > 0) {
      if (!hasBeenDragged) {
        hasBeenDragged = true;
        lockedTheta = currentTheta;
      }
    }

    const sensitivity = 0.005;
    velY = dx * sensitivity;
    velX = dy * sensitivity;

    targetDragRotY += velY;
    targetDragRotX = Math.min(Math.max(targetDragRotX + velX, -Math.PI / 2), Math.PI / 2);
  });

  const stopDrag = (e) => {
    if (isDragging) {
      isDragging = false;
      if (Math.abs(velX) < 0.015 && Math.abs(velY) < 0.015) {
        velX = 0;
        velY = 0;
      }
      try { canvas.releasePointerCapture(e.pointerId); } catch (_) { }
    }
  };

  canvas.addEventListener('pointerup', stopDrag);
  canvas.addEventListener('pointercancel', stopDrag);

  canvas.addEventListener('touchstart', (e) => {
    if (!isFS()) return;
    if (e.touches.length === 2) {
      initialPinchDist = Math.hypot(
        e.touches[0].clientX - e.touches[1].clientX,
        e.touches[0].clientY - e.touches[1].clientY
      );
      initialPinchZoom = targetZoom;
    }
  });

  canvas.addEventListener('touchmove', (e) => {
    if (!isFS()) return;
    if (e.touches.length === 2 && initialPinchDist) {
      const currentDist = Math.hypot(
        e.touches[0].clientX - e.touches[1].clientX,
        e.touches[0].clientY - e.touches[1].clientY
      );
      const factor = initialPinchDist / currentDist;
      targetZoom = Math.min(Math.max(initialPinchZoom * factor, 0.5), 10.0);
    }
  });

  canvas.addEventListener('touchend', (e) => {
    if (e.touches.length < 2) {
      initialPinchDist = null;
    }
  });

  let depthTexture = null;
  let depthTextureView = null;

  function render() {
    const dpr = Math.min(window.devicePixelRatio || 1, maxDPR);
    const displayWidth = Math.floor(canvas.clientWidth * dpr);
    const displayHeight = Math.floor(canvas.clientHeight * dpr);
    if (canvas.width !== displayWidth || canvas.height !== displayHeight) {
      canvas.width = displayWidth;
      canvas.height = displayHeight;
    }

    if (!depthTexture || depthTexture.width !== canvas.width || depthTexture.height !== canvas.height) {
      if (depthTexture) depthTexture.destroy();
      depthTexture = device.createTexture({
        size: [canvas.width, canvas.height],
        format: 'depth24plus',
        usage: GPUTextureUsage.RENDER_ATTACHMENT,
      });
      depthTextureView = depthTexture.createView();
    }

    const rect = figureContainer.getBoundingClientRect();
    const maxScroll = Math.max(0, document.documentElement.scrollHeight - window.innerHeight);
    const clampedScrollY = Math.max(0, Math.min(window.scrollY, maxScroll));
    const absoluteTop = rect.top + window.scrollY;
    const scrollStart = Math.max(0, absoluteTop + rect.height - window.innerHeight);
    const scrollEnd = Math.min(absoluteTop, maxScroll);

    let scrollProgress = 0;
    const scrollRange = scrollEnd - scrollStart;
    if (scrollRange > 0) {
      scrollProgress = (clampedScrollY - scrollStart) / scrollRange;
    }
    scrollProgress = Math.max(0, Math.min(1, scrollProgress));
    const p_eased = scrollProgress * scrollProgress * (3 - 2 * scrollProgress);
    const theta_start = Math.PI / 4;
    const theta_end = Math.PI / 2;
    const scrollTheta = theta_start + (theta_end - theta_start) * p_eased;
    
    if (Math.abs(scrollTheta - lastScrollTheta) > 0.0001) {
      hasBeenDragged = false;
    }
    lastScrollTheta = scrollTheta;

    let targetTheta = scrollTheta;
    if (hasBeenDragged && (isHovering || isFS())) {
      targetTheta = lockedTheta;
    }
    currentTheta += (targetTheta - currentTheta) * 0.1;

    if (!isDragging && !isHovering && !isFS()) {
      let targetWrapY = targetDragRotY % (2 * Math.PI);
      if (targetWrapY > Math.PI) targetWrapY -= 2 * Math.PI;
      if (targetWrapY < -Math.PI) targetWrapY += 2 * Math.PI;
      targetDragRotY = targetWrapY;
      targetDragRotX *= 0.95;
      targetDragRotY *= 0.95;
    } else if (!isDragging) {
      targetDragRotY += velY;
      targetDragRotX = Math.min(Math.max(targetDragRotX + velX, -Math.PI / 2), Math.PI / 2);
      velY *= 0.94;
      velX *= 0.94;

      if (Math.abs(velX) < 0.005 && Math.abs(velY) < 0.005) {
        const vTargets = [
          [-1, -1, -1], [1, 1, -1], [-1, 1, 1], [1, -1, 1],
          [1, 1, 1], [-1, -1, 1], [1, -1, -1], [-1, 1, -1],
          [1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1],
          [1, 1, 0], [1, -1, 0], [-1, 1, 0], [-1, -1, 0],
          [1, 0, 1], [1, 0, -1], [-1, 0, 1], [-1, 0, -1],
          [0, 1, 1], [0, 1, -1], [0, -1, 1], [0, -1, -1]
        ];
        let bestDist = Infinity;
        let bestSnapX = targetDragRotX;
        let bestSnapY = targetDragRotY;
        let ct = Math.cos(currentTheta);
        let st = Math.sin(currentTheta);

        for (let v of vTargets) {
          let mag = Math.hypot(v[0], v[1], v[2]);
          let vx = v[0] / mag;
          let vy = v[1] / mag;
          let vz = v[2] / mag;
          let cx = -st * vx + ct * vy;
          let cy = vz;
          let cz = ct * vx + st * vy;
          let snapX = Math.asin(Math.max(-1, Math.min(1, cy)));
          let snapY = Math.atan2(cx, cz);
          let dy = (snapY - targetDragRotY) % (2 * Math.PI);
          if (dy > Math.PI) dy -= 2 * Math.PI;
          if (dy < -Math.PI) dy += 2 * Math.PI;
          let dx = snapX - targetDragRotX;
          let dist = Math.hypot(dx, dy);
          if (dist < bestDist) {
            bestDist = dist;
            bestSnapX = targetDragRotX + dx;
            bestSnapY = targetDragRotY + dy;
          }
        }
        if (bestDist < 0.02) {
          targetDragRotX += (bestSnapX - targetDragRotX) * 0.1;
          targetDragRotY += (bestSnapY - targetDragRotY) * 0.1;
        }
      }
    }

    currentDragRotX += (targetDragRotX - currentDragRotX) * 0.1;
    let diffY = (targetDragRotY - currentDragRotY) % (2 * Math.PI);
    if (diffY > Math.PI) diffY -= 2 * Math.PI;
    if (diffY < -Math.PI) diffY += 2 * Math.PI;
    currentDragRotY += diffY * 0.1;
    currentZoom += (targetZoom - currentZoom) * 0.1;

    if (hasBeenDragged && !isHovering && !isDragging && !isFS()) {
      const rotNearZero = Math.abs(currentDragRotX) < 0.001 &&
        Math.abs(currentDragRotY) < 0.001 &&
        Math.abs(targetDragRotX) < 0.001 &&
        Math.abs(targetDragRotY) < 0.001;
      const thetaNearScroll = Math.abs(currentTheta - scrollTheta) < 0.001;
      if (rotNearZero && thetaNearScroll) {
        hasBeenDragged = false;
        targetDragRotX = 0;
        targetDragRotY = 0;
        currentDragRotX = 0;
        currentDragRotY = 0;
      }
    }

    uniformData[0] = canvas.width;
    uniformData[1] = canvas.height;
    uniformData[2] = currentDragRotX;
    uniformData[3] = currentDragRotY;
    uniformData[4] = currentZoom;
    uniformData[5] = currentTheta;
    uniformData[6] = isDarkMode;
    uniformData[7] = wireframeLineWidth;
    uniformData[8] = fractalIterations;

    device.queue.writeBuffer(uniformBuffer, 0, uniformData);

    const commandEncoder = device.createCommandEncoder();
    const textureView = context.getCurrentTexture().createView();

    const bgR = isDarkMode ? 0.0 : 0.96;
    const bgG = isDarkMode ? 0.0 : 0.97;
    const bgB = isDarkMode ? 0.0 : 0.98;

    const renderPassDescriptor = {
      colorAttachments: [{
        view: textureView,
        clearValue: { r: bgR, g: bgG, b: bgB, a: 1.0 },
        loadOp: 'clear',
        storeOp: 'store',
      }],
      depthStencilAttachment: {
        view: depthTextureView,
        depthClearValue: 1.0,
        depthLoadOp: 'clear',
        depthStoreOp: 'store',
      },
    };

    const passEncoder = commandEncoder.beginRenderPass(renderPassDescriptor);
    
    if (isWireframe) {
      passEncoder.setPipeline(wireframePipeline);
      passEncoder.setBindGroup(0, wireframeBindGroup);
      passEncoder.setVertexBuffer(0, lineBuffer);
      const instanceCount = Math.max(1, Math.ceil(wireframeLineWidth) * Math.ceil(wireframeLineWidth));
      passEncoder.draw(numLines, instanceCount, 0, 0);
    } else {
      passEncoder.setPipeline(meshPipeline);
      passEncoder.setBindGroup(0, meshBindGroup);
      passEncoder.setVertexBuffer(0, vertexBuffer);
      passEncoder.draw(numVertices, 1, 0, 0);
    }
    passEncoder.end();

    device.queue.submit([commandEncoder.finish()]);
    requestAnimationFrame(render);
  }

  requestAnimationFrame(render);
}

init();
