var async = require('async');
var PNG = require('pngjs').PNG;
var _ = require('lodash');

function __getTempFilename(prefix, ext) {
  var crypto = require('crypto');
  var os = require('os');
  var token = crypto.randomBytes(8).toString('hex');
  return os.tmpdir() + '/' + prefix + '_' + token + '.' + ext;
}

function OffscreenRendererFactory (baseRendererClass) {
  var OffscreenRenderer = function (params) {
    var gl = require('gl');
    // var _gl = gl(1000, 1000);  // gl context will be resized later
    // var ext = _gl.getExtension('STACKGL_resize_drawingbuffer');
    // ext.resize(params.width, params.height);
    // params.context = _gl;
    params.context = gl(params.width, params.height);
    params.isOffscreen = true;
    this.compress = params.compress;  // whether to compress PNG output
    this.skip_existing = params.skip_existing;  // whether to skip rendering existing files
    this.__fs = params.fs || require('./file-util.js');  // filesystem to use for IO
    this.__debugCount = 0; // For debug output
    this.__debugFilename = params.debugFilename;
    baseRendererClass.call(this, params);
    this.canvas = params.canvas;  // Reference to dummy canvas
  };
  OffscreenRenderer.prototype = Object.create(baseRendererClass.prototype);
  OffscreenRenderer.prototype.super = baseRendererClass.prototype;
  OffscreenRenderer.prototype.constructor = OffscreenRenderer;

  // Renders scene from given camera into pngFile and returns raw RGBA pixels
  OffscreenRenderer.prototype.renderToPng = function (scene, camera, basename) {
    var pngfile = _.endsWith(basename, '.png') ? basename : basename + '.png';
    if (this.skip_existing && this.__fs.existsSync(pngfile)) {
      console.log('Skipping render for existing file: ' + pngfile);
      return;
    }
    var pixels = this.render(scene, camera);
    this.writePNG(pngfile, this.width, this.height, pixels);
    if (this.compress) {
      this.__fs.execSync('pngquant -f --ext .png ' + pngfile, { encoding: 'utf8' });
    }
    return pixels;
  };

  // Renders scene from given camera into raw RGBA pixels
  OffscreenRenderer.prototype.render = function (scene, camera) {
    var pixels = this.super.render.call(this, scene, camera);
    this.__flipY(pixels);
    if (this.__debugFilename) {
      this.writePNG(this.__debugFilename + '-' + this.__debugCount + '.png', this.width, this.height, pixels);
      this.__debugCount++;
    }
    return pixels;
  };

  // Renders scene from given camera into raw RGBA pixels
  OffscreenRenderer.prototype.renderToRawPixels = function (scene, camera) {
    return this.render(scene, camera);
  };

  OffscreenRenderer.prototype.renderToBuffer = function (scene, camera) {
    var pixels = this.render(scene, camera);
    var png = new PNG({ width: this.width, height: this.height });
    png.data = Buffer.from(pixels);
    var buff = PNG.sync.write(png);
    return buff;
  };

  OffscreenRenderer.prototype.renderViews = function(scene, opts) {
    if (opts.views === 'turntable') {
      this.renderTurntable(scene, opts);
    } else if (opts.views === 'all') {
      this.renderAllViews(scene, opts);
    } else  {
      console.error('Unknown views: ' + opts.views);
    }
  };

  // Renders turntable views of scene and saves into pngs strippedId_<0-359>.png
  OffscreenRenderer.prototype.renderTurntable = function (scene, opts) {
    var cameraControls = opts.cameraControls;
    var targetBBox = opts.targetBBox;
    var basename = opts.basename;
    var onDone = opts.callback;
    var tilt = opts.tilt || 60;
    var theta = tilt  / 180 * Math.PI;
    var distanceScale = opts.distanceScale || 1.5;
    var angleStart = opts.angleStart || 0;
    var angleEnd = opts.angleEnd || 360;
    var angleStep = opts.angleStep || 1;
    var framerate = opts.framerate || 25;

    var scope = this;
    var angles = _.range(angleStart, angleEnd, angleStep);
    async.forEachOfSeries(angles, function (angle, key, callback) {
      cameraControls.viewTarget({
        targetBBox: targetBBox, distanceScale: distanceScale,
        theta: theta,
        phi: angle / 180 * Math.PI
      });
      var pngfile = basename + '-' + _.padStart(key.toString(), 4, '0') + '.png';
      cameraControls.camera.updateProjectionMatrix();
      scope.renderToPng(scene, cameraControls.camera, pngfile);
      setTimeout(function () { callback(); });
    }, function () {
      if (!opts.skipVideo) {
        scope.pngSeqToVideo(basename + '-%04d.png', basename + '.mp4',
          {width: scope.width, height: scope.height, framerate: framerate});
      }
      onDone();
    });
  };

// Renders all views of scene and saves into pngs strippedId_<viewName>.png
  OffscreenRenderer.prototype.renderAllViews = function (scene, opts) {
    var cameraControls = opts.cameraControls;
    var targetBBox = opts.targetBBox;
    var basename = opts.basename;
    var onDone = opts.callback;

    var views = cameraControls.generateViews(targetBBox, this.width, this.height);
    var scope = this;
    async.forEachSeries(views, function (view, callback) {
      cameraControls.viewTarget(view);
      var pngfile = basename + '-' + view.name + '.png';
      scope.renderToPng(scene, cameraControls.camera, pngfile);
      setTimeout(function () { callback(); });
    }, function () {
      onDone();
    });
  };

  // handle y flip due to WebGL render target
  OffscreenRenderer.prototype.__flipY = function (p) {
    var t;
    var numPixelsPerRow = 4 * this.width;
    for (var row = 0; row < this.height / 2; row++) {
      var yOut = this.height - row - 1;
      var base = numPixelsPerRow * row;
      var baseOut = numPixelsPerRow * yOut;
      for (var col = 0; col < this.width; col++) {
        var step = col << 2;  // 4*x
        var idx = base + step;
        var idxOut = baseOut + step;
        t = p[idxOut    ]; p[idxOut    ] = p[idx    ]; p[idx    ] = t;  // R
        t = p[idxOut + 1]; p[idxOut + 1] = p[idx + 1]; p[idx + 1] = t;  // G
        t = p[idxOut + 2]; p[idxOut + 2] = p[idx + 2]; p[idx + 2] = t;  // B
        t = p[idxOut + 3]; p[idxOut + 3] = p[idx + 3]; p[idx + 3] = t;  // A
      }
    }
  };

  OffscreenRenderer.prototype.writePNG = function (pngFile, width, height, pixels) {
    var png = new PNG({ width: width, height: height });
    //png.data = Buffer.from(pixels);
    for (var i = 0; i < png.data.length; i++) {
      png.data[i] = pixels[i];
    }
    var buff = PNG.sync.write(png);
    this.__fs.writeFileSync(pngFile, buff);
    console.log('Saved ' + pngFile);
  };

// converts png sequence input to video file out
  OffscreenRenderer.prototype.pngSeqToVideo = function (input, out, opts) {
    var tmpfilename = __getTempFilename('white', 'png');
    //console.log(tmpfilename);
    var whitePixels = new Array(opts.width * opts.height * 4).fill(255);
    this.writePNG(tmpfilename, opts.width, opts.height, whitePixels);
    var framerate = opts.framerate || 25;
    var cmdWithArgs = ['ffmpeg', '-y', '-loop','1','-i',tmpfilename,
      '-r', framerate, '-i', input, '-filter_complex','overlay=shortest=1',
      '-r', framerate, out];
    var cmdline = cmdWithArgs.join(' ');
    this.__fs.execSync(cmdline);
    this.__fs.execSync('rm -f ' + tmpfilename);
  };

  return OffscreenRenderer;
}

module.exports = OffscreenRendererFactory;
