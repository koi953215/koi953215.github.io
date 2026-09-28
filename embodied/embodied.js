/*
 * Side-gutter decorations for wide screens. Nothing here touches the 800px content column.
 *
 *   left  - a section rail drawn as a planned (dashed) vs. executed (solid) trajectory with
 *           sampled rollout branches ahead of the agent, and a Franka Panda arm that carries
 *           the agent along it using live inverse kinematics. Hovering a waypoint shows the
 *           arm's imagined reach as a ghost; clicking scrolls there and the arm executes it.
 *   right - a Unitree G1 that is reconstructed from a point cloud into its full mesh (and
 *           periodically re-encoded and decoded), follows the cursor, can be dragged to
 *           rotate, and on click previews its next move as a ghost before acting it out.
 *
 * Robots only load when their gutter is wide enough, and need WebGL2; without it the rail
 * still works on its own. Models: MuJoCo Menagerie unitree_g1 (BSD-3-Clause) and
 * franka_emika_panda (Apache-2.0); see embodied/LICENSES.txt.
 */
(function () {
  'use strict';

  var CONTENT_WIDTH = 800;
  var FPS = 30;
  var FLOOR_PX = 64;     // both robots stand on a floor line this far above the viewport bottom
  var ASSETS = {
    g1: { points: 'embodied/g1-points.js', mesh: 'embodied/g1-mesh.js', global: '__G1' },
    panda: { points: 'embodied/panda-points.js', mesh: 'embodied/panda-mesh.js', global: '__PANDA' }
  };

  var wide = window.matchMedia('(min-width: 1200px)');      // rail + G1
  var armWide = window.matchMedia('(min-width: 1360px)');   // room for the arm beside the rail
  var reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

  function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }
  function smooth(t) { t = clamp(t, 0, 1); return t * t * (3 - 2 * t); }
  function wrapAngle(a) { return Math.atan2(Math.sin(a), Math.cos(a)); }

  // run cb when the browser is idle, but never later than `timeout` ms
  function whenIdle(cb, timeout) {
    if (window.requestIdleCallback) window.requestIdleCallback(function () { cb(); }, { timeout: timeout });
    else setTimeout(cb, 200);
  }

  // <script> tags rather than fetch() so the page also works when opened via file://
  function loadScript(src, onload, onerror) {
    var s = document.createElement('script');
    s.src = src;
    s.async = true;
    s.onload = onload;
    s.onerror = function () { s.remove(); if (onerror) onerror(); };
    document.head.appendChild(s);
  }

  function onChange(mq, fn) {
    if (mq.addEventListener) mq.addEventListener('change', fn);
    else mq.addListener(fn);
  }

  /* ================= Section rail (left gutter) ================= */

  var SHORT_LABELS = {
    'Professional Experience': 'Experience',
    'Awards & Recognitions': 'Awards'
  };

  // what the rail publishes for the arm, in client (viewport) coordinates
  var rail = { ready: false, version: 0, waypoints: [], agent: null, hover: -1 };

  var SVGNS = 'http://www.w3.org/2000/svg';
  function svgEl(tag, cls) {
    var e = document.createElementNS(SVGNS, tag);
    if (cls) e.setAttribute('class', cls);
    return e;
  }

  function buildRail() {
    var headings = Array.prototype.slice.call(document.querySelectorAll('h2'));
    if (!headings.length) return;

    var nav = document.createElement('nav');
    nav.className = 'wm-rail';
    nav.setAttribute('aria-label', 'Sections');

    var svg = svgEl('svg', 'wm-path');
    svg.setAttribute('aria-hidden', 'true');
    var planned = svgEl('path', 'wm-planned');
    var executed = svgEl('path', 'wm-executed');
    var measure = svgEl('path', 'wm-measure');
    svg.appendChild(planned);
    svg.appendChild(executed);
    svg.appendChild(measure);
    var BRANCH_OFFSETS = [-9, -3.5, 5, 10];
    var branches = BRANCH_OFFSETS.map(function () {
      var path = svgEl('path', 'wm-branch');
      var tip = svgEl('circle', 'wm-branch-tip');
      tip.setAttribute('r', '1.6');
      svg.appendChild(path);
      svg.appendChild(tip);
      return { path: path, tip: tip };
    });
    var agent = svgEl('circle', 'wm-agent');
    agent.setAttribute('r', '4.5');
    svg.appendChild(agent);
    nav.appendChild(svg);

    var items = headings.map(function (h, i) {
      var text = h.textContent.trim();
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'wm-waypoint';
      b.innerHTML = '<span class="wm-dot"></span><span class="wm-label"></span>';
      b.lastChild.textContent = SHORT_LABELS[text] || text;
      // scroll to exactly where this waypoint counts as reached, so the agent (and the arm
      // carrying it) stops on the waypoint that was clicked
      b.addEventListener('click', function () {
        window.scrollTo({ top: anchors()[i], behavior: reduceMotion.matches ? 'auto' : 'smooth' });
      });
      function enter() { rail.hover = i; }
      function leave() { if (rail.hover === i) rail.hover = -1; }
      b.addEventListener('mouseenter', enter);
      b.addEventListener('focus', enter);
      b.addEventListener('mouseleave', leave);
      b.addEventListener('blur', leave);
      nav.appendChild(b);
      return { heading: h, button: b };
    });
    document.body.appendChild(nav);

    var pts = [], cum = [], total = 0;   // dot centres (nav-local) and path length at each
    function hidden() { return nav.getClientRects().length === 0; }

    // Scroll position at which each waypoint counts as reached: its heading at 35% of the
    // viewport height. Headings too close to the end of the page to ever get there share the
    // last stretch of scrolling evenly, so the final waypoint is reached exactly at the bottom.
    function anchors() {
      var probe = window.innerHeight * 0.35, y = window.scrollY;
      var maxScroll = Math.max(0, document.documentElement.scrollHeight - window.innerHeight);
      var a = items.map(function (it) { return Math.max(0, it.heading.getBoundingClientRect().top + y - probe); });
      var cut = a.length, k;
      while (cut > 0 && a[cut - 1] >= maxScroll - 1) cut--;
      if (cut < a.length) {
        var start = cut > 0 ? a[cut - 1] : 0, n = a.length - cut;
        for (k = 0; k < n; k++) a[cut + k] = start + (maxScroll - start) * (k + 1) / n;
      }
      for (k = 1; k < a.length; k++) a[k] = Math.max(a[k], a[k - 1] + 1);
      return a;
    }

    function layout() {
      if (hidden()) return;
      pts = items.map(function (it) {
        var d = it.button.firstChild;
        return [d.offsetLeft + d.offsetWidth / 2, d.offsetTop + d.offsetHeight / 2];
      });
      var path = 'M' + pts[0][0] + ' ' + pts[0][1];
      cum = [0];
      for (var i = 1; i < pts.length; i++) {
        var a = pts[i - 1], b = pts[i], dy = b[1] - a[1], bulge = i % 2 ? -9 : 9;
        var seg = 'C' + (a[0] + bulge) + ' ' + (a[1] + dy * 0.35) + ' ' +
                  (b[0] + bulge) + ' ' + (b[1] - dy * 0.35) + ' ' + b[0] + ' ' + b[1];
        measure.setAttribute('d', 'M' + a[0] + ' ' + a[1] + seg);
        cum.push(cum[i - 1] + measure.getTotalLength());
        path += seg;
      }
      total = cum[cum.length - 1];
      planned.setAttribute('d', path);
      executed.setAttribute('d', path);
      rail.version++;
    }

    var pending = false;
    function update() {
      pending = false;
      if (hidden() || !cum.length) { rail.ready = false; return; }
      var last = items.length - 1;
      // progress along the waypoints, interpolated between their anchor scroll positions.
      // At display scaling like 125% a smooth scroll can stop a fraction of a pixel short of
      // its target, so a waypoint within 2px counts as reached.
      var a = anchors(), y = window.scrollY, progress = 0;
      for (var i = 0; i < last; i++) {
        if (y >= a[i] - 2) progress = i + clamp((y - a[i]) / (a[i + 1] - a[i]), 0, 1);
      }
      if (y >= a[last] - 2) progress = last;

      var seg = Math.min(last, Math.floor(progress + 1e-6));
      var f = progress - seg;
      var len = seg >= last ? total : cum[seg] + (cum[seg + 1] - cum[seg]) * f;

      items.forEach(function (it, k) {
        it.button.classList.toggle('is-active', k === seg);
        it.button.classList.toggle('is-passed', k < seg);
      });

      var p = planned.getPointAtLength(len);
      agent.setAttribute('cx', p.x);
      agent.setAttribute('cy', p.y);
      executed.style.strokeDasharray = len + ' ' + (total + 10);

      // rollout branches: bend away from the planned path by a lateral offset that
      // drifts with scroll, so the sampled futures shift as the agent moves
      var ahead = Math.min(total, len + 34);
      var show = ahead - len > 8;
      var q = planned.getPointAtLength(Math.min(total, len + 2));
      var tx = q.x - p.x, ty = q.y - p.y, tn = Math.hypot(tx, ty) || 1;
      var nx = -ty / tn, ny = tx / tn;
      var mid = planned.getPointAtLength((len + ahead) / 2);
      var end = planned.getPointAtLength(ahead);
      branches.forEach(function (b, k) {
        b.path.style.visibility = b.tip.style.visibility = show ? 'visible' : 'hidden';
        if (!show) return;
        var off = BRANCH_OFFSETS[k] + 2.5 * Math.sin(progress * 9 + k * 1.7);
        var ex = end.x + nx * off, ey = end.y + ny * off;
        b.path.setAttribute('d', 'M' + p.x + ' ' + p.y + 'Q' + (mid.x + nx * off * 0.35) + ' ' +
                            (mid.y + ny * off * 0.35) + ' ' + ex + ' ' + ey);
        b.tip.setAttribute('cx', ex);
        b.tip.setAttribute('cy', ey);
      });

      var r = nav.getBoundingClientRect();
      rail.waypoints = pts.map(function (w) { return { x: r.left + w[0], y: r.top + w[1] }; });
      rail.agent = { x: r.left + p.x, y: r.top + p.y };
      rail.ready = true;
    }
    function schedule() {
      if (!pending) { pending = true; requestAnimationFrame(update); }
    }
    window.addEventListener('scroll', schedule, { passive: true });
    window.addEventListener('resize', function () { layout(); schedule(); });
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(function () { layout(); schedule(); });
    layout();
    update();
  }

  /* ================= Kinematics ================= */

  function quatMat(q) {
    var n = Math.hypot(q[0], q[1], q[2], q[3]);
    var w = q[0] / n, x = q[1] / n, y = q[2] / n, z = q[3] / n;
    return [
      1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w),
      2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w),
      2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)
    ];
  }
  function axisMat(a, t) {
    var c = Math.cos(t), s = Math.sin(t), C = 1 - c, x = a[0], y = a[1], z = a[2];
    return [
      c + x * x * C, x * y * C - z * s, x * z * C + y * s,
      y * x * C + z * s, c + y * y * C, y * z * C - x * s,
      z * x * C - y * s, z * y * C + x * s, c + z * z * C
    ];
  }
  function mul(a, b) {
    var o = new Array(9);
    for (var r = 0; r < 3; r++) for (var c = 0; c < 3; c++)
      o[r * 3 + c] = a[r * 3] * b[c] + a[r * 3 + 1] * b[3 + c] + a[r * 3 + 2] * b[6 + c];
    return o;
  }
  function apply(R, v) {
    return [R[0] * v[0] + R[1] * v[1] + R[2] * v[2], R[3] * v[0] + R[4] * v[1] + R[5] * v[2],
            R[6] * v[0] + R[7] * v[1] + R[8] * v[2]];
  }

  // world transform of every link for joint values q (hinge = angle, slide = offset)
  function forwardKinematics(bodies, q) {
    var R = new Array(bodies.length), T = new Array(bodies.length);
    for (var b = 0; b < bodies.length; b++) {
      var body = bodies[b], v = body.joint ? q[body.joint] || 0 : 0;
      var Rl = body.R0, Tl = body.pos;
      if (v && body.slide) {
        var d = apply(body.R0, [body.axis[0] * v, body.axis[1] * v, body.axis[2] * v]);
        Tl = [Tl[0] + d[0], Tl[1] + d[1], Tl[2] + d[2]];
      } else if (v) {
        Rl = mul(Rl, axisMat(body.axis, v));
      }
      if (body.parent < 0) {
        R[b] = Rl;
        T[b] = Tl.slice();
      } else {
        var Rp = R[body.parent], Tp = T[body.parent], o = apply(Rp, Tl);
        R[b] = mul(Rp, Rl);
        T[b] = [Tp[0] + o[0], Tp[1] + o[1], Tp[2] + o[2]];
      }
    }
    return { R: R, T: T };
  }

  // links whose pose differs noticeably between two kinematic states
  function movedBodies(a, b) {
    var out = [];
    for (var i = 0; i < a.R.length; i++) {
      var ta = a.T[i], tb = b.T[i], ra = a.R[i], rb = b.R[i], tr = 0;
      for (var k = 0; k < 9; k++) tr += ra[k] * rb[k];
      if (Math.hypot(ta[0] - tb[0], ta[1] - tb[1], ta[2] - tb[2]) > 0.015 || tr < 2.99) out.push(i);
    }
    return out;
  }

  /* ================= WebGL2 renderer ================= */

  // Every vertex carries one byte: link index (5 bits) | material (3 bits). The shader poses
  // mesh and points on the GPU from one matrix per link.
  var VERT = [
    '#version 300 es',
    'in vec3 a_pos; in vec3 a_nrm; in float a_attr;',
    'uniform mat4 u_links[32];',
    'uniform mat3 u_view;',
    'uniform float u_posScale, u_zOffset, u_focal, u_scale, u_ptSize;',
    'uniform vec2 u_center, u_viewport;',
    'out vec3 v_world; out vec3 v_normal; out float v_depth; flat out int v_mat;',
    'void main() {',
    '  int attr = int(a_attr + 0.5);',
    '  mat4 L = u_links[attr & 31];',
    '  v_mat = attr >> 5;',
    '  vec3 p = (L * vec4(a_pos * u_posScale, 1.0)).xyz;',
    '  p.z -= u_zOffset;',
    '  v_world = p;',
    '  v_normal = mat3(L) * a_nrm;',
    '  vec3 c = u_view * p;',
    '  float s = u_focal / (u_focal - c.z);',
    '  vec2 px = vec2(u_center.x + c.x * s * u_scale, u_center.y - c.y * s * u_scale);',
    '  gl_Position = vec4(px.x / u_viewport.x * 2.0 - 1.0, 1.0 - px.y / u_viewport.y * 2.0, -c.z * 0.4, 1.0);',
    '  gl_PointSize = u_ptSize * s;',
    '  v_depth = c.z;',
    '}'
  ].join('\n');

  var MESH_FRAG = [
    '#version 300 es',
    'precision highp float;',
    'in vec3 v_world; in vec3 v_normal; in float v_depth; flat in int v_mat;',
    'uniform vec3 u_camDir, u_light;',
    'uniform vec3 u_palette[8];',
    'uniform float u_scan, u_hover;',
    'out vec4 o;',
    'void main() {',
    '  if (v_world.z > u_scan) discard;',
    '  vec3 n = normalize(v_normal);',
    '  if (dot(n, u_camDir) < 0.0) n = -n;',
    '  vec3 base = u_palette[v_mat];',
    '  float diff = max(dot(n, u_light), 0.0);',
    '  float hemi = 0.5 + 0.5 * n.z;',
    '  float spec = pow(max(dot(n, normalize(u_light + u_camDir)), 0.0), 40.0);',
    '  vec3 col = base * (0.3 + 0.22 * hemi + 0.56 * diff) + vec3(0.28) * spec;',
    '  float rim = pow(1.0 - max(dot(n, u_camDir), 0.0), 3.0);',
    '  col += vec3(0.09, 0.45, 0.82) * rim * (0.35 + 0.35 * u_hover);',
    '  float edge = 1.0 - smoothstep(0.0, 0.03, u_scan - v_world.z);',
    '  col = mix(col, vec3(0.25, 0.62, 1.0), edge * 0.85);',
    '  o = vec4(col, 1.0);',
    '}'
  ].join('\n');

  var POINT_FRAG = [
    '#version 300 es',
    'precision highp float;',
    'in vec3 v_world; in vec3 v_normal; in float v_depth; flat in int v_mat;',
    'uniform vec3 u_color, u_colorDark;',
    'uniform vec3 u_palette[8];',
    'uniform float u_alpha, u_scan, u_scanMode;',
    'out vec4 o;',
    'void main() {',
    '  vec2 d = gl_PointCoord - 0.5;',
    '  if (dot(d, d) > 0.25) discard;',
    '  float a = u_alpha * (0.45 + 0.55 * clamp((v_depth + 0.3) / 0.6, 0.0, 1.0));',
    '  if (u_scanMode > 0.5) a *= smoothstep(u_scan - 0.005, u_scan + 0.04, v_world.z);',
    '  float lum = dot(u_palette[v_mat], vec3(0.3, 0.59, 0.11));',
    '  vec3 c = mix(u_color, u_colorDark, step(lum, 0.4));',
    '  o = vec4(c * a, a);',
    '}'
  ].join('\n');

  // start compiling and linking; nothing here waits for the driver
  function beginProgram(gl, vs, fs) {
    function sh(type, src) {
      var s = gl.createShader(type);
      gl.shaderSource(s, src);
      gl.compileShader(s);
      return s;
    }
    var p = gl.createProgram();
    gl.attachShader(p, sh(gl.VERTEX_SHADER, vs));
    gl.attachShader(p, sh(gl.FRAGMENT_SHADER, fs));
    gl.bindAttribLocation(p, 0, 'a_pos');
    gl.bindAttribLocation(p, 1, 'a_nrm');
    gl.bindAttribLocation(p, 2, 'a_attr');
    gl.linkProgram(p);
    return p;
  }

  function finishProgram(gl, p) {
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) return null;
    var u = {};
    var count = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
    for (var i = 0; i < count; i++) {
      var name = gl.getActiveUniform(p, i).name.replace(/\[0\]$/, '');
      u[name] = gl.getUniformLocation(p, name);
    }
    return { program: p, u: u };
  }

  function b64(str, Type) {
    var raw = atob(str), bytes = new Uint8Array(raw.length);
    for (var i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
    return new Type(bytes.buffer);
  }

  // One canvas + WebGL2 context + both programs, handed to ready() once the shaders have
  // compiled. With KHR_parallel_shader_compile the driver compiles on its own threads and
  // we poll, so the page never blocks on it. Without WebGL2 the robot is simply skipped.
  function createStage(className, ready) {
    var canvas = document.createElement('canvas');
    canvas.className = className;
    canvas.setAttribute('aria-hidden', 'true');
    var gl = canvas.getContext('webgl2', { antialias: true, alpha: true, premultipliedAlpha: true });
    if (!gl) return;
    var parallel = gl.getExtension('KHR_parallel_shader_compile');
    var pp = beginProgram(gl, VERT, POINT_FRAG), mp = beginProgram(gl, VERT, MESH_FRAG);
    (function poll() {
      if (parallel && !(gl.getProgramParameter(pp, parallel.COMPLETION_STATUS_KHR) &&
                        gl.getProgramParameter(mp, parallel.COMPLETION_STATUS_KHR))) {
        setTimeout(poll, 30);
        return;
      }
      var point = finishProgram(gl, pp), mesh = finishProgram(gl, mp);
      if (!point || !mesh) return;
      document.body.appendChild(canvas);
      ready({ canvas: canvas, gl: gl, point: point, mesh: mesh, W: 0, H: 0, dpr: 1 });
    })();
  }

  function sizeStage(stage, left, width) {
    stage.W = Math.max(0, Math.floor(width));
    stage.H = window.innerHeight;
    stage.dpr = Math.min(window.devicePixelRatio || 1, 2);
    var c = stage.canvas;
    c.style.left = left + 'px';
    c.style.width = stage.W + 'px';
    c.style.height = stage.H + 'px';
    c.width = Math.round(stage.W * stage.dpr);
    c.height = Math.round(stage.H * stage.dpr);
  }

  function vao(gl, pos, nrm, attr, index) {
    var v = gl.createVertexArray();
    gl.bindVertexArray(v);
    gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
    gl.bufferData(gl.ARRAY_BUFFER, pos, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 3, gl.SHORT, false, 0, 0);
    if (nrm) {
      gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
      gl.bufferData(gl.ARRAY_BUFFER, nrm, gl.STATIC_DRAW);
      gl.enableVertexAttribArray(1);
      gl.vertexAttribPointer(1, 3, gl.BYTE, true, 0, 0);
    }
    gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
    gl.bufferData(gl.ARRAY_BUFFER, attr, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(2);
    gl.vertexAttribPointer(2, 1, gl.UNSIGNED_BYTE, false, 0, 0);
    if (index) {
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, gl.createBuffer());
      gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, index, gl.STATIC_DRAW);
    }
    gl.bindVertexArray(null);
    return v;
  }

  // light materials render as the site's off-white, dark ones as slate; accents keep their hue
  function stylePalette(materials) {
    var p = new Float32Array(24);
    materials.forEach(function (c, i) {
      var lum = 0.3 * c[0] + 0.59 * c[1] + 0.11 * c[2];
      var out = lum > 0.5 ? [0.87, 0.89, 0.92] : lum < 0.35 ? [0.21, 0.24, 0.30] : c;
      p.set(out, i * 3);
    });
    return p;
  }

  /* A posable robot on a stage: decoded point cloud (+ optional ground dots) uploaded to the
     GPU, the full mesh attached once it arrives, and draw calls for both. */
  function Rig(stage, data, ground) {
    this.stage = stage;
    this.bodies = data.bodies;
    this.bodies.forEach(function (b) { b.R0 = quatMat(b.quat); });
    this.scale = data.scale;
    this.palette = stylePalette(data.materials);
    var pos = b64(data.points, Int16Array), attr = b64(data.pointAttr, Uint8Array);
    this.nPts = attr.length;
    this.local = new Float32Array(pos.length);
    for (var i = 0; i < pos.length; i++) this.local[i] = pos[i] * data.scale;
    this.groundLink = this.bodies.length;
    this.nGround = ground.length / 3;
    var allPos = new Int16Array(pos.length + ground.length), allAttr = new Uint8Array(this.nPts + this.nGround);
    allPos.set(pos);
    allAttr.set(attr);
    for (i = 0; i < ground.length; i++) allPos[pos.length + i] = Math.round(ground[i] / data.scale);
    allAttr.fill(this.groundLink, this.nPts);
    this.pointVao = vao(stage.gl, allPos, null, allAttr, null);
    this.mesh = null;
  }

  // The mesh is several MB, so it is decoded in steps spread over idle time instead of in
  // one blocking task. Base64 goes through a data: URL fetch, which decodes off the main
  // thread (and works for file:// pages); the synchronous decoder is the fallback.
  Rig.prototype.attachMesh = function (m, done) {
    var self = this, arrays = {};
    function decode(key, Type) {
      return function (next) {
        fetch('data:application/octet-stream;base64,' + m[key])
          .then(function (r) { return r.arrayBuffer(); })
          .then(function (buf) { arrays[key] = new Type(buf); next(); })
          .catch(function () { arrays[key] = b64(m[key], Type); next(); });
      };
    }
    var steps = [
      decode('pos', Int16Array), decode('nrm', Int8Array), decode('attr', Uint8Array), decode('index', Int32Array),
      function (next) {
        var delta = arrays.index, index = new Uint32Array(delta.length);
        for (var i = 0, acc = 0; i < delta.length; i++) { acc += delta[i]; index[i] = acc; }
        arrays.index = index;
        next();
      },
      function () {
        self.mesh = {
          vao: vao(self.stage.gl, arrays.pos, arrays.nrm, arrays.attr, arrays.index),
          count: arrays.index.length, scale: m.scale
        };
        done();
      }
    ];
    (function next() { var step = steps.shift(); if (step) whenIdle(function () { step(next); }, 400); })();
  };

  Rig.prototype.links = function (kin, groundZ) {
    var m = new Float32Array(32 * 16);
    for (var b = 0; b < kin.R.length; b++) {
      var R = kin.R[b], T = kin.T[b], o = b * 16;
      m[o] = R[0]; m[o + 1] = R[3]; m[o + 2] = R[6];
      m[o + 4] = R[1]; m[o + 5] = R[4]; m[o + 6] = R[7];
      m[o + 8] = R[2]; m[o + 9] = R[5]; m[o + 10] = R[8];
      m[o + 12] = T[0]; m[o + 13] = T[1]; m[o + 14] = T[2]; m[o + 15] = 1;
    }
    var g = this.groundLink * 16;
    m[g] = m[g + 5] = m[g + 10] = m[g + 15] = 1;
    m[g + 14] = groundZ;
    return m;
  };

  Rig.prototype.use = function (prog, cam, links, posScale, zOffset) {
    var gl = this.stage.gl, s = this.stage, u = prog.u;
    gl.useProgram(prog.program);
    gl.uniformMatrix4fv(u.u_links, false, links);
    gl.uniformMatrix3fv(u.u_view, false, [
      cam.right[0], cam.up[0], cam.depth[0],
      cam.right[1], cam.up[1], cam.depth[1],
      cam.right[2], cam.up[2], cam.depth[2]
    ]);
    gl.uniform3fv(u.u_palette, this.palette);
    gl.uniform1f(u.u_posScale, posScale);
    gl.uniform1f(u.u_zOffset, zOffset);
    gl.uniform1f(u.u_focal, cam.focal);
    gl.uniform1f(u.u_scale, cam.scale * s.dpr);
    gl.uniform2f(u.u_center, cam.cx * s.dpr, cam.cy * s.dpr);
    gl.uniform2f(u.u_viewport, s.W * s.dpr, s.H * s.dpr);
  };

  // ranges: array of [first, count]
  Rig.prototype.drawPoints = function (cam, links, zOffset, ranges, o) {
    var gl = this.stage.gl, u = this.stage.point.u;
    this.use(this.stage.point, cam, links, this.scale, zOffset);
    gl.uniform1f(u.u_ptSize, o.size * this.stage.dpr);
    gl.uniform3fv(u.u_color, o.color);
    gl.uniform3fv(u.u_colorDark, o.colorDark || o.color);
    gl.uniform1f(u.u_alpha, o.alpha);
    gl.uniform1f(u.u_scan, o.scan === undefined ? 0 : o.scan);
    gl.uniform1f(u.u_scanMode, o.scan === undefined ? 0 : 1);
    gl.bindVertexArray(this.pointVao);
    ranges.forEach(function (r) { if (r[1] > 0) gl.drawArrays(gl.POINTS, r[0], r[1]); });
  };

  Rig.prototype.drawMesh = function (cam, links, zOffset, scan, hover) {
    var gl = this.stage.gl, u = this.stage.mesh.u;
    this.use(this.stage.mesh, cam, links, this.mesh.scale, zOffset);
    gl.uniform3fv(u.u_camDir, cam.depth);
    gl.uniform3fv(u.u_light, cam.light);
    gl.uniform1f(u.u_scan, scan);
    gl.uniform1f(u.u_hover, hover || 0);
    gl.bindVertexArray(this.mesh.vao);
    gl.drawElements(gl.TRIANGLES, this.mesh.count, gl.UNSIGNED_INT, 0);
  };

  Rig.prototype.bodyRanges = function (indices) {
    var bodies = this.bodies;
    return indices.map(function (i) { return [bodies[i].off, bodies[i].cnt]; });
  };

  function beginFrame(stage) {
    var gl = stage.gl;
    gl.viewport(0, 0, stage.canvas.width, stage.canvas.height);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.depthFunc(gl.LEQUAL);
  }

  function makeCamera(yaw, pitch, focal, scale, cx, cy) {
    var cy_ = Math.cos(yaw), sy = Math.sin(yaw), cp = Math.cos(pitch), sp = Math.sin(pitch);
    var right = [sy, cy_, 0], up = [-cy_ * sp, sy * sp, cp], depth = [cy_ * cp, -sy * cp, sp];
    var light = [0, 1, 2].map(function (k) { return depth[k] * 0.55 + up[k] * 0.7 - right[k] * 0.45; });
    var ln = Math.hypot(light[0], light[1], light[2]);
    return {
      right: right, up: up, depth: depth, focal: focal, scale: scale, cx: cx, cy: cy,
      light: light.map(function (v) { return v / ln; })
    };
  }
  function project(cam, p) {
    var x = cam.right[0] * p[0] + cam.right[1] * p[1] + cam.right[2] * p[2];
    var y = cam.up[0] * p[0] + cam.up[1] * p[1] + cam.up[2] * p[2];
    var d = cam.depth[0] * p[0] + cam.depth[1] * p[1] + cam.depth[2] * p[2];
    var s = cam.focal / (cam.focal - d);
    return [cam.cx + x * s * cam.scale, cam.cy - y * s * cam.scale];
  }

  /* Reconstruction scan: the mesh is visible below the scan height, the point cloud above.
     'build' sweeps up (decode), 'dissolve' sweeps down (encode), 'idle' shows the full mesh. */
  function Scan(top) {
    this.top = top;
    this.mode = 'wait';      // before the mesh has arrived: points only
    this.value = -1;
    this.t0 = 0;
    this.lastIdle = 0;
    this.first = true;
  }
  Scan.prototype.build = function (now) { this.mode = 'build'; this.t0 = now; };
  Scan.prototype.cycle = function (now) { this.mode = 'dissolve'; this.t0 = now; this.first = false; };
  Scan.prototype.step = function (now) {
    var u;
    if (this.mode === 'build') {
      u = (now - this.t0) / 1800;
      this.value = -0.02 + (this.top + 0.02) * smooth(u);
      if (u >= 1) { this.mode = 'idle'; this.lastIdle = now; this.first = false; }
    } else if (this.mode === 'dissolve') {
      u = (now - this.t0) / 1200;
      this.value = this.top - (this.top + 0.02) * smooth(u);
      if (u >= 1.2) this.build(now);
    }
  };
  Scan.prototype.meshCut = function () { return this.mode === 'idle' ? 99 : this.value; };
  Scan.prototype.pointsCut = function () { return this.mode === 'wait' ? undefined : this.value; };
  Scan.prototype.busy = function () { return this.mode === 'build' || this.mode === 'dissolve'; };

  /* ================= Shared frame loop ================= */

  var scenes = [];
  var ticking = false, lastTick = 0, rafId = 0;
  function tick(now) {
    rafId = requestAnimationFrame(tick);
    if (lastTick && now - lastTick < 1000 / FPS) return;
    var dt = lastTick ? Math.min(0.1, (now - lastTick) / 1000) : 1 / FPS;
    lastTick = now;
    var any = false;
    scenes.forEach(function (s) { if (s.active()) { any = true; s.frame(dt, now); } });
    if (!any) stopLoop();
  }
  function startLoop() {
    if (ticking || document.hidden) return;
    ticking = true;
    lastTick = 0;
    rafId = requestAnimationFrame(tick);
  }
  function stopLoop() {
    ticking = false;
    cancelAnimationFrame(rafId);
  }
  document.addEventListener('visibilitychange', function () { if (document.hidden) stopLoop(); else startLoop(); });

  var mouse = { x: null, y: null };
  window.addEventListener('mousemove', function (e) { mouse.x = e.clientX; mouse.y = e.clientY; }, { passive: true });
  document.addEventListener('mouseleave', function () { mouse.x = mouse.y = null; });

  /* ================= G1 (right gutter) ================= */

  var BASE_POSE = {
    left_hip_pitch_joint: -0.1, right_hip_pitch_joint: -0.1,
    left_knee_joint: 0.3, right_knee_joint: 0.3,
    left_ankle_pitch_joint: -0.2, right_ankle_pitch_joint: -0.2,
    left_shoulder_pitch_joint: 0.25, right_shoulder_pitch_joint: 0.25,
    left_shoulder_roll_joint: 0.18, right_shoulder_roll_joint: -0.18,
    left_elbow_joint: 0.9, right_elbow_joint: 0.9
  };

  // each click plays the next action: its peak pose is previewed as a ghost, then acted out
  var ACTIONS = [
    {
      label: 'wave',
      peak: { right_shoulder_pitch_joint: -2.55, right_shoulder_roll_joint: -0.35, right_elbow_joint: 0.35 },
      wiggle: { right_shoulder_roll_joint: 0.32, right_elbow_joint: 0.25 }
    },
    {
      label: 'point to the papers',
      // the robot's right arm is the one nearest the content column
      peak: { right_shoulder_pitch_joint: -1.45, right_shoulder_roll_joint: -0.3, right_elbow_joint: 1.4, waist_yaw_joint: -0.3 },
      wiggle: { right_shoulder_pitch_joint: 0.06 }
    },
    {
      label: 'celebrate',
      peak: {
        left_shoulder_pitch_joint: -2.5, left_shoulder_roll_joint: 0.9, left_elbow_joint: 0.35,
        right_shoulder_pitch_joint: -2.5, right_shoulder_roll_joint: -0.9, right_elbow_joint: 0.35,
        left_knee_joint: 0.55, right_knee_joint: 0.55,
        left_hip_pitch_joint: -0.25, right_hip_pitch_joint: -0.25,
        left_ankle_pitch_joint: -0.3, right_ankle_pitch_joint: -0.3
      },
      wiggle: {
        left_knee_joint: -0.22, right_knee_joint: -0.22,
        left_hip_pitch_joint: 0.1, right_hip_pitch_joint: 0.1,
        left_ankle_pitch_joint: 0.12, right_ankle_pitch_joint: 0.12
      }
    }
  ];
  var PREVIEW_MS = 900, ACT_MS = 2600, RESCAN_EVERY_MS = 18000;

  function withBase(overrides) {
    var p = {}, k;
    for (k in BASE_POSE) p[k] = BASE_POSE[k];
    for (k in overrides) p[k] = overrides[k];
    return p;
  }
  function blendPose(base, target, w) {
    var p = {}, k;
    for (k in base) p[k] = base[k];
    for (k in target) p[k] = (p[k] || 0) + (target[k] - (p[k] || 0)) * w;
    return p;
  }

  var BLUE = [0.09, 0.45, 0.82], SLATE = [0.16, 0.2, 0.28], ORANGE = [0.94, 0.57, 0.16];

  function startG1(data) {
    createStage('wm-robot', function (stage) { runG1(stage, data); });
  }

  function runG1(stage, data) {
    var ground = [];
    for (var gx = -4; gx <= 4; gx++) for (var gy = -4; gy <= 4; gy++) {
      if (gx * gx + gy * gy <= 13) ground.push(gx * 0.1, gy * 0.1, 0);
    }
    var rig = new Rig(stage, data, ground);
    var bodies = rig.bodies, canvas = stage.canvas;
    var feet = [];
    bodies.forEach(function (b, i) { if (/ankle_roll/.test(b.name)) feet.push(i); });

    var caption = document.createElement('div');
    caption.className = 'wm-caption';
    caption.setAttribute('aria-hidden', 'true');
    document.body.appendChild(caption);

    var gaze = { yaw: -0.35, pitch: 0.04 }, drag = 0;
    var scan = new Scan(1.45);
    var act = null, actionIndex = 0, hover = 0;
    var bbox = { x0: 0, y0: 0, x1: 0, y1: 0 };
    var dragging = false, downX = 0, downDrag = 0, moved = 0;

    function camera() {
      var W = stage.W, H = stage.H, scale = Math.min(H * 0.4, W * 1.1);
      return makeCamera(-0.5 + drag, 0.12, 4.0, scale, W * 0.56, H - FLOOR_PX);
    }
    function resize() {
      sizeStage(stage, (window.innerWidth + CONTENT_WIDTH) / 2, (window.innerWidth - CONTENT_WIDTH) / 2);
      caption.style.top = Math.round(camera().cy + 30) + 'px';
    }

    // lowest foot point, used to keep the soles on the ground whatever the knees do
    function footZ(kin) {
      var m = Infinity;
      feet.forEach(function (bi) {
        var b = bodies[bi], R = kin.R[bi], T = kin.T[bi], L = rig.local;
        for (var i = b.off; i < b.off + b.cnt; i++) {
          var z = R[6] * L[i * 3] + R[7] * L[i * 3 + 1] + R[8] * L[i * 3 + 2] + T[2];
          if (z < m) m = z;
        }
      });
      return m;
    }

    // idle breathing + cursor-driven waist, blended with the running action
    function pose(t, now) {
      var breathe = reduceMotion.matches ? 0 : Math.sin(t * 1.4);
      var p = withBase({});
      p.waist_yaw_joint = gaze.yaw;
      p.waist_pitch_joint = gaze.pitch + 0.015 * breathe;
      p.left_shoulder_roll_joint += 0.02 * breathe;
      p.right_shoulder_roll_joint -= 0.02 * breathe;
      p.left_elbow_joint += 0.03 * breathe;
      p.right_elbow_joint += 0.03 * breathe;
      if (act && now > act.t0 + PREVIEW_MS) {
        var a = ACTIONS[act.index];
        var u = (now - act.t0 - PREVIEW_MS) / ACT_MS;
        var w = smooth(u / 0.28) * (1 - smooth((u - 0.78) / 0.22));
        var osc = Math.sin(Math.max(0, u - 0.25) * Math.PI * 2 * 3.2) *
                  smooth((u - 0.22) / 0.1) * (1 - smooth((u - 0.7) / 0.1));
        var target = {}, k;
        for (k in a.peak) target[k] = a.peak[k];
        for (k in a.wiggle) target[k] = (k in target ? target[k] : p[k] || 0) + a.wiggle[k] * osc;
        p = blendPose(p, target, w);
      }
      return p;
    }

    function isOnRobot(x, y) {
      var r = canvas.getBoundingClientRect();
      x -= r.left;
      y -= r.top;
      return x > bbox.x0 && x < bbox.x1 && y > bbox.y0 && y < bbox.y1;
    }

    function setCaption(text) {
      if (caption.textContent !== text) caption.textContent = text;
      caption.classList.toggle('is-visible', text !== '');
    }

    function frame(dt, now) {
      var t = now / 1000;
      var tgt = { yaw: -0.35, pitch: 0.04 };
      if (mouse.x !== null && !dragging) {
        var r = canvas.getBoundingClientRect();
        tgt = {
          yaw: clamp((mouse.x - (r.left + stage.W * 0.56)) / 500, -1, 1) * 0.75,
          pitch: clamp((mouse.y - stage.H * 0.4) / 500, -1, 1) * 0.18
        };
      }
      var k = 1 - Math.exp(-dt * 3);
      gaze.yaw += (tgt.yaw - gaze.yaw) * k;
      gaze.pitch += (tgt.pitch - gaze.pitch) * k;
      if (!dragging) drag *= Math.exp(-dt * 2.2);   // ease back to the home view
      hover += ((mouse.x !== null && isOnRobot(mouse.x, mouse.y) ? 1 : 0) - hover) * (1 - Math.exp(-dt * 8));
      if (scan.mode === 'idle' && !act && !dragging && hover < 0.1 && !reduceMotion.matches &&
          now - scan.lastIdle > RESCAN_EVERY_MS) scan.cycle(now);
      scan.step(now);

      var cam = camera();
      var kin = forwardKinematics(bodies, pose(t, now));
      var z0 = footZ(kin);
      var links = rig.links(kin, z0);

      var x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      kin.T.forEach(function (T) {
        var s = project(cam, [T[0], T[1], T[2] - z0]);
        x0 = Math.min(x0, s[0]); x1 = Math.max(x1, s[0]);
        y0 = Math.min(y0, s[1]); y1 = Math.max(y1, s[1]);
      });
      bbox = { x0: x0 - 30, y0: y0 - 45, x1: x1 + 30, y1: y1 + 20 };

      var gl = stage.gl;
      beginFrame(stage);
      gl.disable(gl.DEPTH_TEST);
      rig.drawPoints(cam, links, z0, [[rig.nPts, rig.nGround]], { color: BLUE, alpha: 0.28, size: 2 });
      gl.enable(gl.DEPTH_TEST);
      if (rig.mesh && scan.meshCut() > 0) rig.drawMesh(cam, links, z0, scan.meshCut(), hover);
      if (scan.mode !== 'idle') {
        gl.depthMask(false);
        rig.drawPoints(cam, links, z0, [[0, rig.nPts]],
                       { color: BLUE, colorDark: SLATE, alpha: 0.9, size: 1.8, scan: scan.pointsCut() });
        gl.depthMask(true);
      }

      // preview of the next move: only the chosen action, and only the links it moves
      if (act) {
        var e = now - act.t0;
        var alpha = 0.6 * smooth(e / 300) * (1 - smooth((e - PREVIEW_MS - ACT_MS * 0.05) / (ACT_MS * 0.3)));
        if (alpha > 0.01) {
          var ghost = forwardKinematics(bodies, blendPose(pose(t, 0), ACTIONS[act.index].peak, 1));
          var gz = footZ(ghost);
          gl.disable(gl.DEPTH_TEST);
          rig.drawPoints(cam, rig.links(ghost, gz), gz, rig.bodyRanges(movedBodies(kin, ghost)),
                         { color: ORANGE, alpha: alpha, size: 1.7 });
        }
        var label = ACTIONS[act.index].label;
        setCaption(e < PREVIEW_MS ? 'predicting: ' + label + '…' : 'acting: ' + label);
        if (e > PREVIEW_MS + ACT_MS) { act = null; actionIndex = (actionIndex + 1) % ACTIONS.length; }
      } else if (scan.mode === 'build') {
        setCaption(scan.first ? 'reconstructing…' : 'decoding…');
      } else if (scan.mode === 'dissolve') {
        setCaption('encoding to latent…');
      } else {
        setCaption(hover > 0.5 ? 'click: predict → act  ·  drag: rotate' : '');
      }
    }

    canvas.addEventListener('pointerdown', function (e) {
      dragging = true;
      moved = 0;
      downX = e.clientX;
      downDrag = drag;
      canvas.setPointerCapture(e.pointerId);
      startLoop();
    });
    canvas.addEventListener('pointermove', function (e) {
      if (dragging) {
        moved = Math.max(moved, Math.abs(e.clientX - downX));
        drag = clamp(downDrag + (e.clientX - downX) * 0.012, -2.6, 2.6);
      }
      canvas.style.cursor = dragging ? 'grabbing' : isOnRobot(e.clientX, e.clientY) ? 'pointer' : 'grab';
    });
    function endDrag(e) {
      if (!dragging) return;
      dragging = false;
      if (moved < 4 && isOnRobot(e.clientX, e.clientY) && !act && !scan.busy()) {
        act = { index: actionIndex, t0: performance.now() };
      }
    }
    canvas.addEventListener('pointerup', endDrag);
    canvas.addEventListener('pointercancel', endDrag);
    canvas.addEventListener('webglcontextlost', function (e) { e.preventDefault(); });

    window.addEventListener('resize', function () { resize(); startLoop(); });
    resize();
    scenes.push({ active: function () { return wide.matches; }, frame: frame });
    startLoop();

    whenIdle(function () {
      loadScript(ASSETS.g1.mesh, function () {
        var m = window[ASSETS.g1.global + 'Mesh'];
        window[ASSETS.g1.global + 'Mesh'] = null;          // let the base64 text be collected
        rig.attachMesh(m, function () {
          if (reduceMotion.matches) { scan.mode = 'idle'; scan.lastIdle = performance.now(); }
          else scan.build(performance.now());
        });
      });
    }, 1500);
  }

  /* ================= Franka Panda (left gutter) ================= */

  var ARM_JOINTS = ['joint2', 'joint4', 'joint6'];
  var TCP_OFFSET = 0.105;     // tool point between the fingertips, along the hand's z axis
  var ARM_YAW = 0.4, ARM_FOCAL = 5;

  function startArm(data) {
    createStage('wm-arm', function (stage) { runArm(stage, data); });
  }

  function runArm(stage, data) {
    var ground = [];
    for (var a = 0; a < 18; a++) ground.push(Math.cos(a / 18 * 6.283) * 0.13, Math.sin(a / 18 * 6.283) * 0.13, 0);
    for (a = 0; a < 10; a++) ground.push(Math.cos(a / 10 * 6.283) * 0.07, Math.sin(a / 10 * 6.283) * 0.07, 0);
    var rig = new Rig(stage, data, ground);
    var bodies = rig.bodies;
    var hand = bodies.findIndex(function (b) { return b.name === 'hand'; });
    var ranges = {};
    bodies.forEach(function (b) { if (b.joint && b.range) ranges[b.joint] = b.range; });

    var q = { joint1: 0, joint2: -0.3, joint3: 0, joint4: -2.2, joint5: 0, joint6: 2.0, joint7: 0,
              finger_joint1: 0.04, finger_joint2: 0.04 };
    // roll the hand so the fingers open in the plane of the screen and are visible
    q.joint7 = (function () {
      var best = 0, bestScore = -1;
      for (var k = 0; k < 64; k++) {
        var j7 = -2.8 + k * 5.6 / 63, qq = Object.assign({}, q, { joint7: j7 });
        var R = forwardKinematics(bodies, qq).R[hand];
        var score = 1 - Math.abs(R[4]);               // finger axis (hand y) away from the depth axis
        if (score > bestScore) { bestScore = score; best = j7; }
      }
      return best;
    })();

    var place = null;            // { bx, by, k } base position (px) and pixels per metre
    var target = null;           // smoothed tool target in the arm plane (metres)
    var scan = new Scan(1.25);
    var ghostAlpha = 0, ghostQ = null, lastHover = -1;

    function camera() {
      return makeCamera(Math.PI / 2 - ARM_YAW, 0, ARM_FOCAL, place.k, place.bx, place.by);
    }

    function tcp(kin) {
      var R = kin.R[hand], T = kin.T[hand];
      return { x: T[0] + R[2] * TCP_OFFSET, z: T[2] + R[8] * TCP_OFFSET, a: Math.atan2(R[8], R[2]) };
    }

    // screen point -> point in the arm's vertical plane (y = 0), inverting the weak perspective
    function toPlane(sx, sy) {
      var cam = camera();
      var ax = (sx - cam.cx) / cam.scale, c = Math.cos(ARM_YAW), s = Math.sin(ARM_YAW);
      var x = ax * ARM_FOCAL / (ARM_FOCAL * c + ax * s);
      var persp = ARM_FOCAL / (ARM_FOCAL - x * s);
      return { x: x, z: (cam.cy - sy) / (cam.scale * persp) };
    }

    // damped least squares on (x, z, approach angle) with joints 2, 4 and 6; a joint pinned
    // at a limit and pushed further is dropped from the Jacobian so the others compensate
    function solve(qs, tx, tz, ta, iters) {
      var W = 0.08, h = 1e-4, lambda = 0.04;
      for (var it = 0; it < iters; it++) {
        var f = tcp(forwardKinematics(bodies, qs));
        var e = [tx - f.x, tz - f.z, W * wrapAngle(ta - f.a)];
        if (Math.hypot(e[0], e[1], e[2]) < 2e-4) break;
        var J = [[], [], []];
        for (var j = 0; j < 3; j++) {
          var qq = Object.assign({}, qs);
          qq[ARM_JOINTS[j]] += h;
          var g = tcp(forwardKinematics(bodies, qq));
          J[0][j] = (g.x - f.x) / h;
          J[1][j] = (g.z - f.z) / h;
          J[2][j] = W * wrapAngle(g.a - f.a) / h;
        }
        var locked = [false, false, false], dq;
        for (var pass = 0; pass < 2; pass++) {
          dq = dlsStep(J, e, lambda, locked);
          var again = false;
          for (j = 0; j < 3; j++) {
            var rg = ranges[ARM_JOINTS[j]] || [-2.9, 2.9], v = qs[ARM_JOINTS[j]];
            if (!locked[j] && ((v >= rg[1] - 0.03 && dq[j] > 0) || (v <= rg[0] + 0.03 && dq[j] < 0))) {
              locked[j] = again = true;
            }
          }
          if (!again) break;
        }
        for (j = 0; j < 3; j++) {
          var name = ARM_JOINTS[j], lim = ranges[name] || [-2.9, 2.9];
          qs[name] = clamp(qs[name] + clamp(dq[j], -0.3, 0.3), lim[0] + 0.02, lim[1] - 0.02);
        }
      }
      return qs;
    }
    // dq = J^T (J J^T + lambda^2 I)^-1 e, with locked joints' columns zeroed
    function dlsStep(J, e, lambda, locked) {
      var Jm = J.map(function (row) { return row.map(function (v, c) { return locked[c] ? 0 : v; }); });
      var A = [0, 1, 2].map(function (r) {
        return [0, 1, 2].map(function (c) {
          return Jm[r][0] * Jm[c][0] + Jm[r][1] * Jm[c][1] + Jm[r][2] * Jm[c][2] + (r === c ? lambda * lambda : 0);
        });
      });
      var y = solve3(A, e);
      return [0, 1, 2].map(function (j) { return Jm[0][j] * y[0] + Jm[1][j] * y[1] + Jm[2][j] * y[2]; });
    }
    function solve3(A, b) {
      var det = A[0][0] * (A[1][1] * A[2][2] - A[1][2] * A[2][1]) -
                A[0][1] * (A[1][0] * A[2][2] - A[1][2] * A[2][0]) +
                A[0][2] * (A[1][0] * A[2][1] - A[1][1] * A[2][0]);
      function col(k) { return A.map(function (row, r) { return row.map(function (v, c) { return c === k ? b[r] : v; }); }); }
      function d3(M) {
        return M[0][0] * (M[1][1] * M[2][2] - M[1][2] * M[2][1]) -
               M[0][1] * (M[1][0] * M[2][2] - M[1][2] * M[2][0]) +
               M[0][2] * (M[1][0] * M[2][1] - M[1][1] * M[2][0]);
      }
      return [d3(col(0)) / det, d3(col(1)) / det, d3(col(2)) / det];
    }

    // gripper roughly level for high targets, tilting toward top-down for low ones, which
    // keeps the wrist inside its range
    function approach(p) { return clamp(-1.3 + 1.9 * (p.z - 0.1) / 0.8, -1.3, 0.5); }

    // Fit the arm beside the rail: base on the floor line, left of the waypoints, sized so
    // the farthest waypoint sits at a comfortable ~0.74 m reach from the shoulder. The
    // elbow swings back when reaching low, so every waypoint's pose is solved up front and
    // the base nudged right until no pose leaves the gutter.
    var placedVersion = -1;
    function scaleFor(bx, by) {
      var wps = rail.waypoints, lo = 30, hi = 6000, c = Math.cos(ARM_YAW);
      for (var i = 0; i < 40; i++) {
        var k = (lo + hi) / 2, sy = by - 0.333 * k, m = 0;
        wps.forEach(function (w) { m = Math.max(m, Math.hypot((w.x - bx) / (k * c), (w.y - sy) / k)); });
        if (m > 0.74) lo = k; else hi = k;
      }
      return hi;
    }
    function leftmost() {
      var cam = camera(), min = Infinity;
      rail.waypoints.forEach(function (w) {
        var p = toPlane(w.x, w.y);
        var kin = forwardKinematics(bodies, solve(Object.assign({}, q), p.x, p.z, approach(p), 60));
        kin.T.forEach(function (T) { min = Math.min(min, project(cam, T)[0] - 0.07 * place.k); });
      });
      return min;
    }
    function fit() {
      var wps = rail.waypoints;
      if (!rail.ready || wps.length < 2) return false;
      var dotX = wps[0].x, span = wps[wps.length - 1].y - wps[0].y;
      var bx = Math.max(34, dotX - 0.62 * span), by = window.innerHeight - FLOOR_PX;
      if (dotX - bx < 45) return false;
      place = { bx: bx, by: by, k: scaleFor(bx, by) };
      for (var i = 0; i < 4; i++) {
        var overflow = 10 - leftmost();
        if (overflow <= 0) break;
        bx = Math.min(dotX - 45, bx + overflow);
        place = { bx: bx, by: by, k: scaleFor(bx, by) };
      }
      placedVersion = rail.version;
      return true;
    }

    function resize() {
      sizeStage(stage, 0, (window.innerWidth - CONTENT_WIDTH) / 2);
      placedVersion = -1;
    }

    function frame(dt, now) {
      if (placedVersion !== rail.version || !place) {
        if (!fit()) { stage.canvas.style.visibility = 'hidden'; return; }
        target = null;
      }
      stage.canvas.style.visibility = 'visible';
      scan.step(now);
      if (scan.mode === 'idle' && !reduceMotion.matches && rail.hover < 0 &&
          now - scan.lastIdle > RESCAN_EVERY_MS + 7000) scan.cycle(now);

      // follow the agent (smoothed), holding it between the fingers
      var goal = toPlane(rail.agent.x, rail.agent.y);
      if (!target) target = goal;
      var k = 1 - Math.exp(-dt * 7);
      target = { x: target.x + (goal.x - target.x) * k, z: target.z + (goal.z - target.z) * k };
      solve(q, target.x, target.z, approach(target), 6);
      var grip = clamp(4.8 / place.k * 1.1, 0.004, 0.04);
      q.finger_joint1 += (grip - q.finger_joint1) * k;
      q.finger_joint2 = q.finger_joint1;

      // hovering a waypoint: imagine the reach to it as a ghost
      if (rail.hover >= 0) {
        if (rail.hover !== lastHover || !ghostQ) {
          var w = rail.waypoints[rail.hover], p = toPlane(w.x, w.y);
          ghostQ = solve(Object.assign({}, q, { finger_joint1: 0.04, finger_joint2: 0.04 }), p.x, p.z, approach(p), 60);
          lastHover = rail.hover;
        }
        ghostAlpha += (0.6 - ghostAlpha) * (1 - Math.exp(-dt * 8));
      } else {
        ghostAlpha += (0 - ghostAlpha) * (1 - Math.exp(-dt * 8));
        lastHover = -1;
      }

      var cam = camera();
      var kin = forwardKinematics(bodies, q);
      var links = rig.links(kin, 0);
      var gl = stage.gl;
      beginFrame(stage);
      gl.disable(gl.DEPTH_TEST);
      rig.drawPoints(cam, links, 0, [[rig.nPts, rig.nGround]], { color: BLUE, alpha: 0.35, size: 2 });
      gl.enable(gl.DEPTH_TEST);
      if (rig.mesh && scan.meshCut() > 0) rig.drawMesh(cam, links, 0, scan.meshCut(), 0);
      if (scan.mode !== 'idle') {
        gl.depthMask(false);
        rig.drawPoints(cam, links, 0, [[0, rig.nPts]],
                       { color: BLUE, colorDark: SLATE, alpha: 0.9, size: 1.7, scan: scan.pointsCut() });
        gl.depthMask(true);
      }
      if (ghostAlpha > 0.01 && ghostQ) {
        var gk = forwardKinematics(bodies, ghostQ);
        gl.disable(gl.DEPTH_TEST);
        rig.drawPoints(cam, rig.links(gk, 0), 0, rig.bodyRanges(movedBodies(kin, gk)),
                       { color: ORANGE, alpha: ghostAlpha, size: 1.6 });
      }
    }

    window.addEventListener('resize', function () { resize(); startLoop(); });
    window.addEventListener('scroll', startLoop, { passive: true });
    resize();
    scenes.push({ active: function () { return armWide.matches; }, frame: frame });
    startLoop();

    whenIdle(function () {
      loadScript(ASSETS.panda.mesh, function () {
        var m = window[ASSETS.panda.global + 'Mesh'];
        window[ASSETS.panda.global + 'Mesh'] = null;       // let the base64 text be collected
        rig.attachMesh(m, function () {
          if (reduceMotion.matches) { scan.mode = 'idle'; scan.lastIdle = performance.now(); }
          else scan.build(performance.now());
        });
      });
    }, 2500);
  }

  /* ================= boot ================= */

  function loader(key, mq, start) {
    var loaded = false;
    function load() {
      if (loaded || !mq.matches) return;
      loaded = true;
      loadScript(ASSETS[key].points, function () { start(window[ASSETS[key].global + 'Points']); },
                 function () { loaded = false; });
    }
    onChange(mq, function () { load(); startLoop(); });
    return load;
  }

  function boot() {
    buildRail();
    var loadG1 = loader('g1', wide, startG1);
    var loadArm = loader('panda', armWide, startArm);
    whenIdle(function () { loadG1(); loadArm(); }, 1500);
  }

  if (document.readyState === 'complete') boot();
  else window.addEventListener('load', boot);
})();
