/*
 * 印章提取（extractstamp）— 基于 OpenCV.js 的本地印章抠取
 *
 * 上游参考：https://github.com/xxss0903/extractstamp （"extract stamp by opencvjs"）
 *   思路：把图片转到 HSV，用双区间红色掩码取出红章，再用 HoughCircles 定位圆形印章并裁剪。
 *
 * 本文件是在 IT-Tools fork 中的集成实现（非上游逐行拷贝），相对上游做了以下修正与增强：
 *   1. 【修正】就绪检测：上游 initOpenCV() 只判断 `typeof cv !== 'undefined'`，
 *      而 opencv.js 的 wasm 是异步初始化的 —— 脚本刚执行时 cv 对象已存在但 cv.Mat 还没有，
 *      此时上游会立刻回调 ready=true，用户在这个窗口期内操作必然失败。
 *      本实现改为真正等待 cv.Mat 可用（含 onRuntimeInitialized + 轮询兜底 + 超时）。
 *   2. 【修正】裁剪边界：上游对贴边印章会把 ROI 裁到图像内，但圆形 mask 仍按未裁剪的
 *      size×size 构造，两者尺寸不一致；本实现对 mask 使用 ROI 的实际尺寸，并把圆形遮罩
 *      直接以 ROI 坐标系绘制，不再有尺寸假设。
 *   3. 【增强】大图性能：HoughCircles 在检测前把图降采样到最长边 ≤ maxSide，
 *      检出结果再映射回全分辨率坐标裁剪，兼顾速度与输出清晰度。
 *   4. 【增强】可在「保留原色」与「统一着色」之间选择（上游只能着单色）。
 *   5. 【增强】非圆形印章支持：不做圆形限定时，用 findContours 按连通区域外接框提取，
 *      方形章、椭圆章、异形章也能取出。
 *   6. 【增强】紧致裁剪：按 alpha 非零包围盒裁掉透明边，输出不含大片空白。
 *   7. 【修正】内存：所有 cv.Mat 在 finally 中释放（上游在抛错路径上会泄漏 wasm 内存）。
 */

(function (global) {
  'use strict';

  var DEFAULT_MAX_SIDE = 1600;

  /** 颜色预设：印章以红、蓝为主 */
  var COLOR_PRESETS = {
    red: {
      label: '红色印章',
      ranges: [[0, 50, 50, 10, 255, 255], [170, 50, 50, 180, 255, 255]],
    },
    blue: {
      label: '蓝色印章',
      ranges: [[100, 60, 40, 130, 255, 255]],
    },
  };

  // ---------------------------------------------------------------- 就绪检测

  function isCvReady() {
    return typeof cv !== 'undefined' && !!cv && !!cv.Mat;
  }

  /**
   * 真正等到 OpenCV.js 的 wasm runtime 可用（cv.Mat 可构造）才 resolve。
   * 这是对上游 `typeof cv !== 'undefined'` 判断的修正。
   */
  function loadOpenCV(timeoutMs) {
    var limit = timeoutMs || 180000;
    if (isCvReady()) return Promise.resolve(true);
    return new Promise(function (resolve, reject) {
      var settled = false;
      var t0 = Date.now();

      function done() {
        if (settled) return;
        settled = true;
        resolve(true);
      }
      function fail(msg) {
        if (settled) return;
        settled = true;
        reject(new Error(msg));
      }

      function waitObject() {
        if (typeof cv === 'undefined') {
          if (Date.now() - t0 > limit) return fail('OpenCV.js 加载超时（未出现 cv 对象）');
          return setTimeout(waitObject, 80);
        }
        // 注意：某些构建（如 @techstark/opencv-js）的 cv 是 thenable，且 cv.Mat 会在
        // 稍后挂到**同一个** cv 对象上。所以这里绝不能因为 cv.then 存在就 return，
        // 必须始终落到下面的轮询 —— 否则 promise 不 resolve 时会永久挂住。
        try {
          if (cv && typeof cv.then === 'function') {
            cv.then(function (m) {
              if (m && m.Mat && !isCvReady()) global.cv = m;
            }).catch(function () { /* 加载失败由轮询超时统一报错 */ });
          }
          if (cv && !cv.Mat && 'onRuntimeInitialized' in cv) {
            var prev = cv.onRuntimeInitialized;
            cv.onRuntimeInitialized = function () {
              if (typeof prev === 'function') prev();
              poll();
            };
          }
        } catch (e) { /* 某些构建上属性只读，忽略，走轮询 */ }
        poll();
      }

      function poll() {
        if (isCvReady()) return done();
        if (Date.now() - t0 > limit) return fail('OpenCV.js 初始化超时（cv.Mat 一直不可用）');
        setTimeout(poll, 80);
      }

      waitObject();
    });
  }

  // ---------------------------------------------------------------- 工具函数

  function hexToRgb(hex) {
    var h = String(hex || '#ff0000').replace('#', '').trim();
    if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    var n = parseInt(h.slice(0, 6), 16);
    if (isNaN(n)) return [255, 0, 0];
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }

  function toImage(source) {
    if (source instanceof HTMLImageElement && source.complete && source.naturalWidth) {
      return Promise.resolve(source);
    }
    if (source instanceof Blob || source instanceof File) {
      return new Promise(function (resolve, reject) {
        var url = URL.createObjectURL(source);
        var img = new Image();
        img.onload = function () { URL.revokeObjectURL(url); resolve(img); };
        img.onerror = function () { URL.revokeObjectURL(url); reject(new Error('图片解码失败，请换一张图片')); };
        img.src = url;
      });
    }
    if (typeof source === 'string') {
      return new Promise(function (resolve, reject) {
        var img = new Image();
        img.onload = function () { resolve(img); };
        img.onerror = function () { reject(new Error('图片加载失败')); };
        img.src = source;
      });
    }
    if (source && source.width && source.height) return Promise.resolve(source);
    return Promise.reject(new Error('不支持的输入类型'));
  }

  function makeCanvas(w, h) {
    var c = document.createElement('canvas');
    c.width = Math.max(1, w | 0);
    c.height = Math.max(1, h | 0);
    return c;
  }

  function canvasFromImage(img, w, h) {
    var c = makeCanvas(w, h);
    var ctx = c.getContext('2d');
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(img, 0, 0, c.width, c.height);
    return c;
  }

  function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }

  // ---------------------------------------------------------------- 掩码构造

  /**
   * 按颜色预设与容差构造 CV_8UC1 掩码（进 mask，输出 0/255）。
   * tolerance 1..10：越大越宽容（能取到更淡、更偏的印章）。
   */
  function buildColorMask(hsv, mask, preset, tolerance) {
    var t = clamp(Number(tolerance) || 5, 1, 10);
    // 容差映射到 S/V 下限：t=1 → 苛刻，t=10 → 宽松
    var satMin = Math.round(150 - t * 13);   // 137 .. 20
    var valMin = Math.round(140 - t * 12);   // 128 .. 20

    var acc = null;
    var ranges = preset.ranges;
    for (var i = 0; i < ranges.length; i++) {
      var r = ranges[i];
      var lo = new cv.Mat(hsv.rows, hsv.cols, hsv.type(), [r[0], Math.min(satMin, r[1] + 0), Math.min(valMin, r[2] + 0), 0]);
      var hi = new cv.Mat(hsv.rows, hsv.cols, hsv.type(), [r[3], 255, 255, 255]);
      var part = new cv.Mat();
      cv.inRange(hsv, lo, hi, part);
      if (acc === null) {
        acc = part;
      } else {
        cv.add(acc, part, acc);
        part.delete();
      }
      lo.delete();
      hi.delete();
    }
    if (acc === null) { mask.delete(); return; }
    acc.copyTo(mask);
    acc.delete();
  }

  /**
   * 边缘回补：把被抗锯齿/纸张洇开冲淡的**印章外缘**接回硬掩码。
   *
   * 为什么需要：外圈最外侧只有 1~3px，压在纸色上（S 常常掉到 50 以下），
   * 硬阈值直接把它丢掉 → 掩码边界落在印章内侧 → 裁出来的图"少一圈"。
   *
   * 做法：用最宽松阈值再取一次掩码，但**只允许从现有硬掩码向外生长**
   * （逐次 1px 膨胀 ∩ 宽松掩码），生长轮数按图幅给。这样能顺着真实的
   * 淡边接出去，又不会把远处的泛黄纸底、粉色表格线一起拖进来。
   */
  function recoverRim(hsv, mask, preset) {
    var loose = new cv.Mat();
    var near = new cv.Mat();
    var k3 = null;
    try {
      buildColorMask(hsv, loose, preset, 10);
      k3 = cv.getStructuringElement(cv.MORPH_ELLIPSE, new cv.Size(3, 3));
      // 图越大，淡边的绝对像素越宽：500px → 2 轮，4000px → 6 轮
      var rounds = clamp(Math.round(Math.min(mask.rows, mask.cols) / 700), 2, 6);
      for (var i = 0; i < rounds; i++) {
        cv.dilate(mask, near, k3, new cv.Point(-1, -1), 1);
        cv.bitwise_and(near, loose, near);
        cv.bitwise_or(mask, near, mask);
      }
    } catch (e) {
      // 回补失败不影响主流程（退化为原本的硬掩码）
    } finally {
      loose.delete();
      near.delete();
      if (k3) k3.delete();
    }
  }

  // ---------------------------------------------------------------- 区域检测

  /**
   * 在降采样灰度掩码上检测圆形印章。
   * 返回全分辨率坐标系下的 {x, y, r} 列表（去重、按半径降序）。
   */
  function detectCircles(maskSmall, scale, circleThreshold) {
    var blur = new cv.Mat();
    var found = [];
    try {
      cv.GaussianBlur(maskSmall, blur, new cv.Size(5, 5), 2, 2);
      var minDim = Math.min(blur.rows, blur.cols);
      var minR = Math.max(8, minDim * 0.045);
      var maxR = minDim * 0.45;
      var minDist = Math.max(15, minDim * 0.1);
      var base = clamp(Number(circleThreshold) || 45, 8, 120);

      // 自适应：候选过多说明阈值偏松（大半径的假圆通常密度很低），逐步抬高 param2。
      // 实测真实印章的红色密度约 0.5~0.6，而误检大圆多在 0.1~0.25，
      // 密度区间取 0.15~0.85：掐掉接近空白的，也掐掉整片实心色块。
      var best = [];
      for (var attempt = 0; attempt < 4; attempt++) {
        var p2 = base + attempt * 12;
        var cur = [];
        var circles = new cv.Mat();
        try {
          cv.HoughCircles(blur, circles, cv.HOUGH_GRADIENT, 1, minDist, 120, p2, minR, maxR);
          for (var i = 0; i < circles.cols; i++) {
            var x = circles.data32F[i * 3];
            var y = circles.data32F[i * 3 + 1];
            var r = circles.data32F[i * 3 + 2];
            if (!isFinite(x) || !isFinite(y) || !isFinite(r) || r <= 0) continue;
            var dens = circleDensity(blur, x, y, r);
            if (dens < 0.15 || dens > 0.85) continue;
            cur.push({ x: x / scale, y: y / scale, r: r / scale, density: dens });
          }
        } finally {
          circles.delete();
        }
        if (!cur.length) break;
        best = cur;
        // 收进合理范围就停；过多则继续抬高阈值
        if (cur.length <= 12) break;
      }
      found = best;
    } catch (e) {
      // HoughCircles 在极端参数下可能抛错：退化为不做圆形限定
      found = [];
    } finally {
      blur.delete();
    }
    found.sort(function (a, b) { return b.r - a.r; });
    // 同心圆只保留最外圈：Hough 经常同时锁到内圈和外圈，若用内圈半径去硬切，
    // 外圈就会被整圈切掉（实测同一枚章只出到内圈 r=76，而真实外缘在 104）。
    var uniq = [];
    for (var m = 0; m < found.length; m++) {
      var c0 = found[m];
      var swallowed = false;
      for (var n = 0; n < uniq.length; n++) {
        var k = uniq[n];
        var dd = Math.sqrt((c0.x - k.x) * (c0.x - k.x) + (c0.y - k.y) * (c0.y - k.y));
        if (dd < k.r * 0.25 && c0.r < k.r * 0.92) { swallowed = true; break; }
      }
      if (!swallowed) uniq.push(c0);
    }
    return uniq;
  }

  /**
   * 把圆半径贴着掩码真实外缘拟合。
   *
   * HoughCircles 给的 r 只是"检到的那条圆"，有可能落在内圈。这里在半径
   * [r, r*maxGrow] 的搜索窗内找**离圆心最远的掩码像素**，用它当切割半径，
   * 保证外圈不会被切掉；maxGrow 兜住"相邻印章误入窗口"的情况。
   */
  /**
   * 把检测到的圆"吸附"到真正属于它的连通域上，返回连通域的外接框（矩形）。
   *
   * 为什么这么做：如果按圆半径做**圆形硬切**，Hough 一旦锁到内圈、或几个圆
   * 圆心半径各不相同，就会（a）把外圈切掉（用户反馈的"少一圈/选在内侧"），
   * （b）在**同一枚章**上吐出好几个互相重叠的结果。
   * 现在圆检测只负责回答"这团是不是圆的"，裁剪范围一律取连通域的真实外接框，
   * 并按连通域去重 —— 一枚章只会有一个结果。
   */
  function snapCirclesToBoxes(circles, boxes) {
    var out = [];
    var used = [];
    for (var i = 0; i < circles.length; i++) {
      var c = circles[i];
      var best = -1, bestD = Infinity;
      for (var j = 0; j < boxes.length; j++) {
        var b = boxes[j];
        var bx = b.x + b.w / 2, by = b.y + b.h / 2;
        var dd = Math.sqrt((bx - c.x) * (bx - c.x) + (by - c.y) * (by - c.y));
        if (dd < bestD && dd <= c.r * 0.7) { bestD = dd; best = j; }
      }
      if (best >= 0) {
        if (used[best]) continue;          // 同一个连通域已经出过结果
        used[best] = 1;
        out.push(boxes[best]);
      }
    }
    return out;
  }

  /**
   * 非圆形模式：用连通域外接框定位印章。
   * 返回全分辨率坐标系下的 {x, y, w, h} 列表。
   * minSide：最小边长，用来滤掉被阈值切散的文字碎片/笔画残渣。
   */
  function detectBoxes(maskFull, minAreaRatio, maxAreaRatio, minSide) {
    var contours = new cv.MatVector();
    var hierarchy = new cv.Mat();
    var boxes = [];
    try {
      cv.findContours(maskFull, contours, hierarchy, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);
      var total = maskFull.rows * maskFull.cols;
      for (var i = 0; i < contours.size(); i++) {
        var c = contours.get(i);
        try {
          var rect = cv.boundingRect(c);
          if (rect.width < minSide || rect.height < minSide) continue;
          var area = cv.contourArea(c);
          if (area < total * minAreaRatio || area > total * maxAreaRatio) continue;
          // 过于细长的多半是笔画/边框碎片，不是印章
          var ar = rect.width / Math.max(1, rect.height);
          if (ar > 6 || ar < 1 / 6) continue;
          // 细长图形（红色箭头、下划线、指示线、表框）不是印章：
          // 用**最小外接矩形**判长短边比，斜着画的箭头也能挡掉。
          // 真实印章（圆形 / 方形 / 椭圆 / 发票章）长短边比一般不超过 2。
          var rr = cv.minAreaRect(c);
          var sw = rr.size.width, sh = rr.size.height;
          var lng = Math.max(sw, sh), sht = Math.min(sw, sh);
          if (sht > 0.5 && lng / sht > 2.4) continue;
          boxes.push({ x: rect.x, y: rect.y, w: rect.width, h: rect.height, area: area });
        } finally {
          c.delete();
        }
      }
      hierarchy.delete();
      contours.delete();
    } catch (e) {
      hierarchy.delete();
      contours.delete();
      boxes = [];
    }
    // 去掉被更大框包含的重复框（同一印章内部被切散的小块）
    boxes.sort(function (a, b) { return b.area - a.area; });
    var kept = [];
    for (var j = 0; j < boxes.length; j++) {
      var b = boxes[j];
      var contained = kept.some(function (k) {
        return b.x >= k.x - 2 && b.y >= k.y - 2 &&
          b.x + b.w <= k.x + k.w + 2 && b.y + b.h <= k.y + k.h + 2;
      });
      if (!contained) kept.push(b);
    }
    return kept;
  }

  /**
   * 统计降采样掩码在某个圆内的红色密度（0..1）。
   * 用来剔除 HoughCircles 的假阳性：真正的印章是"稀疏的环形线条+星徽"，
   * 密度大体落在 0.03~0.5；空区域接近 0，整片文字区域则偏高。
   */
  function circleDensity(mask, cx, cy, r) {
    var x0 = Math.max(0, Math.floor(cx - r)), x1 = Math.min(mask.cols - 1, Math.ceil(cx + r));
    var y0 = Math.max(0, Math.floor(cy - r)), y1 = Math.min(mask.rows - 1, Math.ceil(cy + r));
    if (x1 <= x0 || y1 <= y0) return 0;
    var data = mask.data, W = mask.cols;
    var hit = 0, tot = 0, r2 = r * r;
    for (var y = y0; y <= y1; y += 2) {
      for (var x = x0; x <= x1; x += 2) {
        var dx = x - cx, dy = y - cy;
        if (dx * dx + dy * dy > r2) continue;
        tot++;
        if (data[y * W + x]) hit++;
      }
    }
    return tot ? hit / tot : 0;
  }

  // ---------------------------------------------------------------- 输出构造

  /**
   * 从全分辨率 src(RGBA) + mask(8UC1) 里按区域裁出一张 PNG dataURL。
   * alpha 取自 mask；RGB 视 mode 取原色或统一着色；圆模式再叠加圆形遮罩。
   * 最后按 alpha 包围盒紧致裁剪，去掉透明边。
   */
  function cropRegion(srcMat, maskMat, region, opt) {
    var W = srcMat.cols, H = srcMat.rows;

    // 圆形模式的切割半径要先贴住掩码真实外缘，再据此定裁剪窗
    // （若直接用 Hough 给的 r，锁到内圈时外圈会被整圈切掉）
    // 裁剪框：一律取区域外接框 + 少量 padding。
    // 不再做"按圆半径硬切"——实测那会把外圈切掉，且同一枚章吐出多个重叠结果。
    // 印章的形状信息本来就在掩码里，按掩码取 alpha 即可，无需再用圆去裁。
    var pad = 0.03;
    var x0, y0, x1, y1;
    var p = Math.max(region.w, region.h) * pad;
    x0 = region.x - p; y0 = region.y - p;
    x1 = region.x + region.w + p; y1 = region.y + region.h + p;
    x0 = clamp(Math.floor(x0), 0, W - 1);
    y0 = clamp(Math.floor(y0), 0, H - 1);
    x1 = clamp(Math.ceil(x1), 1, W);
    y1 = clamp(Math.ceil(y1), 1, H);
    var w = x1 - x0, h = y1 - y0;
    if (w <= 1 || h <= 1) return null;

    // ⚠️ 关键：cv.Mat.roi() 返回的子矩阵**行步长仍是父矩阵的宽度**（非连续内存），
    // 直接按 yy*w+xx 去读它的 data 会取到错位的像素（表现为满屏噪点）。
    // 这里用 copyTo 复制成连续矩阵，data 才是紧密排列的 rows*cols。
    var tS = srcMat.roi(new cv.Rect(x0, y0, w, h));
    var tM = maskMat.roi(new cv.Rect(x0, y0, w, h));
    var roiSrc = new cv.Mat();
    var roiMask = new cv.Mat();
    tS.copyTo(roiSrc);
    tM.copyTo(roiMask);
    tS.delete();
    tM.delete();
    var out = null;
    try {
      out = new cv.Mat(h, w, cv.CV_8UC4, new cv.Scalar(0, 0, 0, 0));
      var sd = roiSrc.data, md = roiMask.data, od = out.data;
      var rgb = opt.rgb;

      // 形状信息全在掩码里，直接用掩码当 alpha，不再做圆形硬切
      var cx = region.x - x0, cy = region.y - y0, rr = 0;

      for (var yy = 0; yy < h; yy++) {
        for (var xx = 0; xx < w; xx++) {
          var mi = yy * w + xx;
          var a = md[mi];
          if (!a) continue;
          var si = mi * 4, oi = si;
          if (opt.mode === 'color') {
            od[oi] = rgb[0]; od[oi + 1] = rgb[1]; od[oi + 2] = rgb[2];
          } else {
            od[oi] = sd[si]; od[oi + 1] = sd[si + 1]; od[oi + 2] = sd[si + 2];
          }
          od[oi + 3] = a;
        }
      }

      // 紧致裁剪：按 alpha 非零包围盒
      var minX = w, minY = h, maxX = -1, maxY = -1;
      for (var ry = 0; ry < h; ry++) {
        for (var rx = 0; rx < w; rx++) {
          if (od[(ry * w + rx) * 4 + 3]) {
            if (rx < minX) minX = rx;
            if (rx > maxX) maxX = rx;
            if (ry < minY) minY = ry;
            if (ry > maxY) maxY = ry;
          }
        }
      }
      if (maxX < 0) return null;
      var tw = maxX - minX + 1, th = maxY - minY + 1;

      // 紧致裁剪。同样要 clone：cv.imshow 内部按"连续内存"读取 mat.data，
      // 直接传 roi 子矩阵会输出错位图像。
      var tT = out.roi(new cv.Rect(minX, minY, tw, th));
      var tight = tT.clone();
      tT.delete();
      var canvas = makeCanvas(tw, th);
      cv.imshow(canvas, tight);
      tight.delete();

      var pixels = 0;
      for (var mi2 = 0; mi2 < md.length; mi2++) if (md[mi2]) pixels++;

      return {
        dataUrl: canvas.toDataURL('image/png'),
        width: tw,
        height: th,
        pixels: pixels,
      };
    } finally {
      if (out) out.delete();
      roiSrc.delete();
      roiMask.delete();
    }
  }

  /** 在原图上画出检测到的印章轮廓，供页面预览 */
  function makeOverlay(img, regions, circle) {
    var canvas = canvasFromImage(img, img.naturalWidth || img.width, img.naturalHeight || img.height);
    var ctx = canvas.getContext('2d');
    ctx.lineWidth = Math.max(2, Math.round(Math.max(canvas.width, canvas.height) / 400));
    ctx.strokeStyle = 'rgba(255,64,64,0.95)';
    ctx.fillStyle = 'rgba(255,64,64,0.95)';
    ctx.font = ctx.lineWidth * 7 + 'px sans-serif';
    regions.forEach(function (r, i) {
      ctx.beginPath();
      if (circle) {
        ctx.arc(r.x, r.y, r.r, 0, Math.PI * 2);
      } else {
        ctx.rect(r.x, r.y, r.w, r.h);
      }
      ctx.stroke();
      var lx = circle ? r.x - r.r : r.x;
      var ly = circle ? r.y - r.r : r.y;
      ctx.fillText(String(i + 1), Math.max(2, lx + 4), Math.max(14, ly - 4));
    });
    return canvas.toDataURL('image/png');
  }

  // ---------------------------------------------------------------- 主流程

  /**
   * 提取印章。
   * @param {File|Blob|HTMLImageElement|string} source 输入图片
   * @param {object} options
   *   color      'red' | 'blue'            印章颜色（默认 red）
   *   tolerance  1..10                     颜色容差（默认 5）
   *   circleOnly boolean                   只提取圆形印章（默认 false）
   *   circleThreshold 8..120               HoughCircles 累加器阈值（默认 45，越小越灵敏）
   *   mode       'original' | 'color'      输出保留原色或统一着色（默认 original）
   *   outColor   '#rrggbb'                 统一着色时的颜色（默认 #ff0000）
   *   maxSide    number                    检测降采样最长边（默认 1600）
   *   maxStamps  number                    最多输出张数（默认 24）
   * @returns {Promise<{stamps:Array, overlay:string, width:number, height:number, maskPixels:number, circle:boolean}>}
   */
  function extractStamps(source, options) {
    var opt = options || {};
    var circleOnly = !!opt.circleOnly;
    var preset = COLOR_PRESETS[opt.color] || COLOR_PRESETS.red;
    var maxSide = Math.max(200, Number(opt.maxSide) || DEFAULT_MAX_SIDE);
    var maxStamps = Math.max(1, Number(opt.maxStamps) || 24);
    var mode = opt.mode === 'color' ? 'color' : 'original';
    var rgb = hexToRgb(opt.outColor);

    return loadOpenCV(opt.timeoutMs).then(function () {
      return toImage(source);
    }).then(function (img) {
      var W = img.naturalWidth || img.width;
      var H = img.naturalHeight || img.height;
      if (!W || !H) throw new Error('图片尺寸无效');

      var fullCanvas = canvasFromImage(img, W, H);
      var srcMat = null, hsv = null, maskFull = null, kernel = null, small = null;
      try {
        srcMat = cv.imread(fullCanvas);
        hsv = new cv.Mat();
        cv.cvtColor(srcMat, hsv, cv.COLOR_RGBA2RGB);
        cv.cvtColor(hsv, hsv, cv.COLOR_RGB2HSV);

        maskFull = new cv.Mat();
        buildColorMask(hsv, maskFull, preset, opt.tolerance);

        // 闭运算补掉笔画间的细缝，让印章成为一个整体
        kernel = cv.getStructuringElement(cv.MORPH_ELLIPSE, new cv.Size(3, 3));
        cv.morphologyEx(maskFull, maskFull, cv.MORPH_CLOSE, kernel);

        // 把被冲淡的印章外缘接回来（否则裁出来会"少一圈"）
        recoverRim(hsv, maskFull, preset);

        var maskPixels = cv.countNonZero(maskFull);
        if (!maskPixels) {
          return {
            stamps: [], overlay: canvasFromImage(img, W, H).toDataURL('image/png'),
            width: W, height: H, maskPixels: 0, circle: circleOnly, empty: true,
          };
        }

        // 降采样用于检测（大图 HoughCircles 很慢）
        var scale = Math.min(1, maxSide / Math.max(W, H));
        var sw = Math.max(1, Math.round(W * scale));
        var sh = Math.max(1, Math.round(H * scale));
        small = new cv.Mat();
        cv.resize(maskFull, small, new cv.Size(sw, sh), 0, 0, cv.INTER_AREA);

        var regions = [];
        // 最小边长：太小的一律视为文字碎片/笔画残渣。
        // 默认取图片短边的 2%，但不低于 24px（证书小字、边框都能被挡掉）。
        var minSide = Math.max(24, Number(opt.minSide) || Math.round(Math.min(W, H) * 0.02));
        // 连通域总是要先算：圆形模式也要用它来定真实裁剪范围
        var boxes = detectBoxes(maskFull, 0.0004, 0.9, minSide);
        if (circleOnly) {
          // 圆检测只用来筛"这团是不是圆的"，裁剪范围取连通域外接框。
          // 旧实现按圆半径硬切：Hough 锁到内圈就切掉外圈（"少一圈"），
          // 而且同一枚章会因多个圆吐出好几个重叠结果。
          var circles = detectCircles(small, scale, opt.circleThreshold);
          regions = snapCirclesToBoxes(circles, boxes);
          if (!regions.length) {
            // 兜底：连不上任何连通域时，用圆的矩形外接框（依然不做圆形硬切）
            regions = circles.map(function (c) {
              return { x: c.x - c.r, y: c.y - c.r, w: c.r * 2, h: c.r * 2 };
            });
          }
        } else {
          regions = boxes.map(function (b) { return { x: b.x, y: b.y, w: b.w, h: b.h }; });
          if (regions.length === 0) {
            // 圆检测作为补充：有些印章连通域被断开，但圆形轮廓明显
            var cs = detectCircles(small, scale, opt.circleThreshold);
            regions = cs.map(function (c) {
              return { x: c.x - c.r, y: c.y - c.r, w: c.r * 2, h: c.r * 2 };
            });
          }
        }

        // 按阅读顺序（先上后下、再从左到右）排序，让叠加图上的红框编号与下方结果列表的
        // 顺序一致。否则按面积排序时编号会跳着走（实测出现 2→3→4→1 的乱序），很难对照。
        regions.sort(function (a, b) {
          var ah = a.h || a.r * 2 || 1;
          var bh = b.h || b.r * 2 || 1;
          var tol = Math.min(ah, bh) * 0.5; // 同一行内允许的纵向抖动
          if (Math.abs(a.y - b.y) > tol) return a.y - b.y;
          return a.x - b.x;
        });

        var out = [];
        for (var i = 0; i < regions.length && out.length < maxStamps; i++) {
          var r = cropRegion(srcMat, maskFull, regions[i], {
            mode: mode, rgb: rgb,
          });
          // 紧致裁剪后再兜一层：贴边被裁残的小块、以及几像素的退化结果直接丢弃
          if (r && r.width >= minSide && r.height >= minSide && r.pixels >= 120) {
            r.circle = circleOnly;
            r.index = out.length + 1;
            out.push(r);
          }
        }

        return {
          stamps: out,
          overlay: makeOverlay(img, regions.slice(0, maxStamps), false),
          width: W,
          height: H,
          maskPixels: maskPixels,
          circle: circleOnly,
          circles: regions.map(function (r) {
            return { x: Math.round(r.x), y: Math.round(r.y), r: r.r ? Math.round(r.r) : null };
          }),
        };
      } finally {
        if (srcMat) srcMat.delete();
        if (hsv) hsv.delete();
        if (maskFull) maskFull.delete();
        if (kernel) kernel.delete();
        if (small) small.delete();
      }
    });
  }

  // ---------------------------------------------------------------- 导出

  var api = {
    loadOpenCV: loadOpenCV,
    isCvReady: isCvReady,
    extractStamps: extractStamps,
    COLOR_PRESETS: COLOR_PRESETS,
    version: '1.0.0',

    // ---- 兼容上游 README 里的三个函数名 ----
    initOpenCV: function (cb) {
      loadOpenCV().then(function () { if (cb) cb(true); })
        .catch(function () { if (cb) cb(false); });
    },
    extractStampWithFile: function (file, setColor, isCircle) {
      return extractStamps(file, {
        mode: setColor ? 'color' : 'original',
        outColor: setColor || '#ff0000',
        circleOnly: !!isCircle,
      }).then(function (r) { return r.stamps.map(function (s) { return s.dataUrl; }); });
    },
    extractStampWithImage: function (img, setColor) {
      return extractStamps(img, {
        mode: setColor ? 'color' : 'original',
        outColor: setColor || '#ff0000',
      }).then(function (r) { return r.stamps.map(function (s) { return s.dataUrl; }); });
    },
  };

  global.ExtractStamp = api;
  global.initOpenCV = api.initOpenCV;
  global.extractStampWithFile = api.extractStampWithFile;
  global.extractStampWithImage = api.extractStampWithImage;
})(typeof window !== 'undefined' ? window : this);
