//jshint node: true, browser: true, worker: true

'use strict';
var createLinearGradient = require('./createLinearGradient'),
    createRadialGradient = require('./createRadialGradient'),
    events = require('events'),
    util = require('util'),
    keycode = require('keycode'),
    transformPoints = require('./transformPoints'),
    pointInPolygon = require('point-in-polygon'),
    identity = new Float64Array([1, 0, 0, 1, 0, 0]);

util.inherits(Renderer, events.EventEmitter);

function Renderer(width, height, parent, worker) {
  //this needs to be done later because of cyclical dependencies
  events.EventEmitter.call(this);

  //virtual stack
  this.transformStack = [identity];
  this.fillStyleStack = [];
  this.strokeStyleStack = [];
  this.lineStyleStack = [];
  this.textStyleStack = [];
  this.shadowStyleStack = [];
  this.globalAlphaStack = [];
  this.imageSmoothingEnabledStack = [];
  this.globalCompositeOperationStack = [];




  this.pi2 = Math.PI * 2;

  this.isReady = false;
  this.mouseState = 'up';
  this.mouseData = {
    x: 0,
    y: 0,
    state: this.mouseState,
    activeRegions: []
  };
  this.lastMouseEvent = null;
  this.ranMouseEvent = false;
  this.mouseRegions = [];
  this.activeRegions = [];
  this.styleQueue = [];

  //this is the basic structure of the data sent to the web worker
  this.keyData = {};

  //set parent
  if (parent && parent.nodeType === 1) {
    this.parent = parent;
  } else {
    this.parent = window.document.createElement('div');
    this.parent.style.margin = '0 auto';
    this.parent.style.width = width + 'px';
    this.parent.style.height = height + 'px';
    window.document.body.appendChild(this.parent);
  }

  //set width and height automatically
  if (!width || width <= 0) {
    width = window.innerWidth;
  }

  if (!height || height <= 0) {
    height = window.innerHeight;
  }

  this.canvas = window.document.createElement('canvas');

  //focusable canvas bugfix
  this.canvas.tabIndex = 1;

  this.ctx = this.canvas.getContext('2d');

  this.canvas.width = width;
  this.canvas.height = height;
  this.parent.appendChild(this.canvas);

  //hook mouse and keyboard events right away
  this.hookMouseEvents();
  this.hookKeyboardEvents();

  this.boundHookRenderFunction = this.hookRender.bind(this);
  Object.seal(this);
}

Renderer.prototype.render = function render(args) {
  var i,
      len,
      child,
      props,
      type,
      cache,
      matrix,
      sinr,
      cosr,
      ctx = this.ctx,
      children = [],
      concat = children.concat;

  //flush the virtual stack
  this.transformStack.splice(0, this.transformStack.length, identity);
  this.fillStyleStack.splice(0, this.fillStyleStack.length);
  this.strokeStyleStack.splice(0, this.strokeStyleStack.length);
  this.lineStyleStack.splice(0, this.lineStyleStack.length);
  this.textStyleStack.splice(0, this.textStyleStack.length);
  this.shadowStyleStack.splice(0, this.shadowStyleStack.length);
  this.globalCompositeOperationStack.splice(0, this.globalCompositeOperationStack.length);
  this.globalAlphaStack.splice(0, this.globalAlphaStack.length);
  this.imageSmoothingEnabledStack.splice(0, this.imageSmoothingEnabledStack.length);

  for (i = 0, len = arguments.length; i < len; i++) {
    children.push(arguments[i]);
  }

  for (i = 0, len = children.length; i < len; i++) {
    child = children[i];

    if (child && child.constructor === Array) {
      children = concat.apply([], children);
      child = children[i];
      while (child && child.constructor === Array) {
        children = concat.apply([], children);
        child = children[i];
      }
      len = children.length;
    }

    if (!child) {
      continue;
    }

    props = child.props;
    type = child.type;

    if (type === 'transform') {
      cache = this.transformStack[this.transformStack.length - 1];
      matrix = new Float64Array([
        cache[0] * props[0] + cache[2] * props[1],
        cache[1] * props[0] + cache[3] * props[1],
        cache[0] * props[2] + cache[2] * props[3],
        cache[1] * props[2] + cache[3] * props[3],
        cache[0] * props[4] + cache[2] * props[5] + cache[4],
        cache[1] * props[4] + cache[3] * props[5] + cache[5]
      ]);

      this.transformStack.push(matrix);
      ctx.setTransform(matrix[0], matrix[1], matrix[2], matrix[3], matrix[4], matrix[5]);

      continue;
    }

    if (type === 'setTransform') {
      matrix = new Float64Array(props);
      this.transformStack.push(matrix);
      ctx.setTransform(matrix[0], matrix[1], matrix[2], matrix[3], matrix[4], matrix[5]);
      continue;
    }

    if (type === 'scale') {
      matrix = new Float64Array(this.transformStack[this.transformStack.length - 1]);
      matrix[0] *= props.x;
      matrix[1] *= props.x;
      matrix[2] *= props.y;
      matrix[3] *= props.y;

      this.transformStack.push(matrix);
      ctx.setTransform(matrix[0], matrix[1], matrix[2], matrix[3], matrix[4], matrix[5]);

      continue;
    }

    if (type === 'translate') {
      matrix = new Float64Array(this.transformStack[this.transformStack.length - 1]);
      matrix[4] += matrix[0] * props.x + matrix[2] * props.y;
      matrix[5] += matrix[1] * props.x + matrix[3] * props.y;

      this.transformStack.push(matrix);
      ctx.setTransform(matrix[0], matrix[1], matrix[2], matrix[3], matrix[4], matrix[5]);

      continue;
    }

    if (type === 'rotate') {
      cosr = Math.cos(props.r);
      sinr = Math.sin(props.r);

      cache = this.transformStack[this.transformStack.length - 1];
      matrix = new Float64Array(cache);

      matrix[0] = cache[0] * cosr + cache[2] * sinr;
      matrix[1] = cache[1] * cosr + cache[3] * sinr;
      matrix[2] = cache[0] * -sinr + cache[2] * cosr;
      matrix[3] = cache[1] * -sinr + cache[3] * cosr;

      this.transformStack.push(matrix);
      ctx.setTransform(matrix[0], matrix[1], matrix[2], matrix[3], matrix[4], matrix[5]);

      continue;
    }

    if (type === 'restore') {
      this.transformStack.pop();
      matrix = this.transformStack[this.transformStack.length - 1];
      ctx.setTransform(matrix[0], matrix[1], matrix[2], matrix[3], matrix[4], matrix[5]);

      continue;
    }

    if (type === 'fillRect') {
      ctx.fillRect(props.x, props.y, props.width, props.height);

      continue;
    }

    if (type === 'strokeRect') {
      ctx.strokeRect(props.x, props.y, props.width, props.height);

      continue;
    }

    if (type === 'clearRect') {
      ctx.clearRect(props.x, props.y, props.width, props.height);

      continue;
    }

    if (type === 'rect') {
      ctx.rect(props.x, props.y, props.width, props.height);

      continue;
    }

    if (type === 'fillStyle') {
      this.fillStyleStack.push(ctx.fillStyle);
      ctx.fillStyle = props.value;

      continue;
    }

    if (type === 'strokeStyle') {
      this.strokeStyleStack.push(ctx.strokeStyle);
      ctx.strokeStyle = props.value;

      continue;
    }

    if (type === 'endFillStyle') {
      ctx.fillStyle = this.fillStyleStack.pop();

      continue;
    }

    if (type === 'endStrokeStyle') {
      ctx.strokeStyle = this.strokeStyleStack.pop();

      continue;
    }
    if (type === 'lineStyle') {
      this.lineStyleStack.push({
        lineWidth: ctx.lineWidth,
        lineCap: ctx.lineCap,
        lineJoin: ctx.lineJoin,
        miterLimit: ctx.miterLimit,
        lineDash: ctx.getLineDash(),
        lineDashOffset: ctx.lineDashOffset
      });

      if (props.lineWidth !== null) {
        ctx.lineWidth = props.lineWidth;
      }
      if (props.lineCap !== null) {
        ctx.lineCap = props.lineCap;
      }
      if (props.lineJoin !== null) {
        ctx.lineJoin = props.lineJoin;
      }
      if (props.miterLimit !== null) {
        ctx.miterLimit = props.miterLimit;
      }
      if (props.lineDash.length > 0) {
        ctx.setLineDash(props.lineDash);
      }
      if (props.lineDashOffset !== null) {
        ctx.lineDashOffset = props.lineDashOffset;
      }

      continue;
    }

    if (type === 'endLineStyle') {
      cache = this.lineStyleStack.pop();
      ctx.lineWidth = cache.lineWidth;
      ctx.lineCap = cache.lineCap;
      ctx.lineJoin = cache.lineJoin;
      ctx.miterLimit = cache.miterLimit;
      ctx.setLineDash(cache.lineDash);
      ctx.lineDashOffset = cache.lineDashOffset;

      continue;
    }

    if (type === 'textStyle') {
      this.textStyleStack.push({
        font: ctx.font,
        textAlign: ctx.textAlign,
        textBaseline: ctx.textBaseline,
        direction: ctx.direction
      });
      if (props.font !== null) {
        ctx.font = props.font;
      }
      if (props.textAlign !== null) {
        ctx.textAlign = props.textAlign;
      }
      if (props.textBaseline !== null) {
        ctx.textBaseline = props.textBaseline;
      }
      if (props.lineJoin !== null) {
        ctx.direction = props.direction;
      }

      continue;
    }

    if (type === 'endTextStyle') {
      cache = this.textStyleStack.pop();
      ctx.font = cache.font;
      ctx.textAlign = cache.textAlign;
      ctx.textBaseline = cache.textBaseline;
      ctx.direction = cache.direction;

      continue;
    }

    if (type === 'shadowStyle') {
      this.shadowStyleStack.push({
        shadowBlur: ctx.shadowBlur,
        shadowColor: ctx.shadowColor,
        shadowOffsetX: ctx.shadowOffsetX,
        shadowOffsetY: ctx.shadowOffsetY
      });
      if (props.shadowBlur !== null) {
        ctx.shadowBlur = props.shadowBlur;
      }
      if (props.shadowColor !== null) {
        ctx.shadowColor = props.shadowColor;
      }
      if (props.shadowOffsetX !== null) {
        ctx.shadowOffsetX = props.shadowOffsetX;
      }
      if (props.shadowOffsetY !== null) {
        ctx.shadowOffsetY = props.shadowOffsetY;
      }

      continue;
    }

    if (type === 'endShadowStyle') {
      cache = this.shadowStyleStack.pop();
      ctx.shadowBlur = cache.shadowBlur;
      ctx.shadowColor = cache.shadowColor;
      ctx.shadowOffsetX = cache.shadowOffsetX;
      ctx.shadowOffsetY = cache.shadowOffsetY;

      continue;
    }

    if (type === 'strokeText') {
      if (props.maxWidth) {
        ctx.strokeText(props.text, props.x, props.y, props.maxWidth);
        continue;
      }
      ctx.strokeText(props.text, props.x, props.y);
      continue;
    }

    if (type === 'fillText') {
      if (props.maxWidth) {
        ctx.fillText(props.text, props.x, props.y, props.maxWidth);
        continue;
      }
      ctx.fillText(props.text, props.x, props.y);
      continue;
    }

    if (type === 'text') {
      if (props.maxWidth !== 0) {
        if (props.fill) {
          ctx.fillText(props.text, props.x, props.y, props.maxWidth);
        }
        if (props.stroke) {
          ctx.strokeText(props.text, props.x, props.y, props.maxWidth);
        }

        continue;
      }
      if (props.fill) {
        ctx.fillText(props.text, props.x, props.y);
      }
      if (props.stroke) {
        ctx.strokeText(props.text, props.x, props.y);
      }

      continue;
    }



    if (type === 'drawImage') {
      if (!props.img) {
        continue;
      }
      ctx.drawImage(props.img.imageElement || new Image(), props.dx, props.dy);
      continue;
    }

    if (type === 'drawImageSize') {
      if (!props.img) {
        continue;
      }
      ctx.drawImage(props.img.imageElement || new Image(), props.dx, props.dy, props.dWidth, props.dHeight);
      continue;
    }

    if (type === 'drawImageSource') {
      if (!props.img) {
        continue;
      }
      ctx.drawImage(props.img.imageElement || new Image(), props.sx, props.sy, props.sWidth, props.sHeight, props.dx, props.dy, props.dWidth, props.dHeight);
      continue;
    }

    if (type === 'fillImagePattern') {
      if (!props.img) {
        continue;
      }
      ctx.fillStyle = props.img.imagePatternRepeat;
      ctx.translate(props.dx, props.dy);
      ctx.fillRect(0, 0, props.dWidth, props.dHeight);
      ctx.restore();

      continue;
    }

    if (type === 'fillImage') {
      if (!props.img) {
        continue;
      }
      cache = props.img.imageElement;
      ctx.save();
      ctx.fillStyle = props.img.imagePattern;
      ctx.translate(props.dx, props.dy);
      ctx.fillRect(0, 0, cache.width, cache.height);
      ctx.restore();

      continue;
    }

    if (type === 'fillImageSize') {
      if (!props.img) {
        continue;
      }
      cache = props.img.imageElement;
      ctx.save();
      ctx.fillStyle = props.img.imagePattern;
      ctx.translate(props.dx, props.dy);
      ctx.scale(props.dWidth / cache.width, props.dHeight / cache.height);
      ctx.fillRect(0, 0, cache.width, cache.height);
      ctx.restore();

      continue;
    }

    if (type === 'fillImageSource') {
      if (!props.img) {
        continue;
      }
      ctx.save();
      ctx.fillStyle = props.img.imagePattern;
      ctx.translate(props.dx, props.dy);
      ctx.scale(props.dWidth / props.sWidth, props.dHeight / props.sHeight);
      ctx.translate(-props.sx, -props.sy);
      ctx.fillRect(props.sx, props.sy, props.sWidth, props.sHeight);
      ctx.restore();

      continue;
    }


    if (type === 'fillCanvas') {
      if (!props.img) {
        continue;
      }
      cache = props.img;
      ctx.save();
      ctx.fillStyle = cache.fillPattern;
      ctx.translate(props.dx, props.dy);
      ctx.fillRect(0, 0, cache.width, cache.height);
      ctx.restore();

      continue;
    }

    if (type === 'fillCanvasSize') {
      if (!props.img) {
        continue;
      }
      cache = props.img;
      ctx.save();
      ctx.fillStyle = cache.fillPattern;
      ctx.translate(props.dx, props.dy);
      ctx.scale(props.dWidth / cache.width, props.dHeight / cache.height);
      ctx.fillRect(0, 0, cache.width, cache.height);
      ctx.restore();

      continue;
    }

    if (type === 'fillCanvasSource') {
      if (!props.img) {
        continue;
      }
      ctx.save();
      ctx.fillStyle = props.img.fillPattern;
      ctx.translate(props.dx, props.dy);
      ctx.scale(props.dWidth / props.sWidth, props.dHeight / props.sHeight);
      ctx.translate(-props.sx, -props.sy);
      ctx.fillRect(props.sx, props.sy, props.sWidth, props.sHeight);
      ctx.restore();

      continue;
    }

    if (type === 'drawCanvas') {
      if (!props.img) {
        continue;
      }
      ctx.drawImage(props.img.renderer.canvas, props.dx, props.dy);
      continue;
    }

    if (type === 'drawCanvasSize') {
      if (!props.img) {
        continue;
      }
      ctx.drawImage(props.img.renderer.canvas, props.dx, props.dy, props.dWidth, props.dHeight);

      continue;
    }

    if (type === 'drawCanvasSource') {
      if (!props.img) {
        continue;
      }
      ctx.drawImage(props.img.renderer.canvas, props.sx, props.sy, props.sWidth, props.sHeight, props.dx, props.dy, props.dWidth, props.dHeight);

      continue;
    }

    if (type === 'strokeArc') {
      ctx.beginPath();
      ctx.arc(props.x, props.y, props.r, props.startAngle, props.endAngle);
      ctx.closePath();
      ctx.stroke();

      continue;
    }

    if (type === 'strokeArc-counterclockwise') {
      ctx.beginPath();
      ctx.arc(props.x, props.y, props.r, props.startAngle, props.endAngle, true);
      ctx.closePath();
      ctx.stroke();

      continue;
    }


    if (type === 'fillArc') {
      ctx.beginPath();
      ctx.arc(props.x, props.y, props.r, props.startAngle, props.endAngle);
      ctx.closePath();
      ctx.fill();

      continue;
    }

    if (type === 'fillArc-counterclockwise') {
      ctx.beginPath();
      ctx.arc(props.x, props.y, props.r, props.startAngle, props.endAngle, true);
      ctx.closePath();
      ctx.fill();

      continue;
    }

    if (type === 'moveTo') {
      ctx.moveTo(props.x, props.y);

      continue;
    }

    if (type === 'lineTo') {
      ctx.lineTo(props.x, props.y);

      continue;
    }

    if (type === 'bezierCurveTo') {
      ctx.bezierCurveTo(props.cp1x, props.cp1y, props.cp2x, props.cp2y, props.x, props.y);

      continue;
    }

    if (type === 'quadraticCurveTo') {
      ctx.quadraticCurveTo(props.cpx, props.cpy, props.x, props.y);

      continue;
    }

    if (type === 'anticlockwise-arc') {
      ctx.arc(props.x, props.y, props.r, props.startAngle, props.endAngle, true);

      continue;
    }

    if (type === 'arc') {
      ctx.arc(props.x, props.y, props.r, props.startAngle, props.endAngle);
      continue;
    }

    if (type === 'full-arc') {
      ctx.arc(props.x, props.y, props.r, 0, this.pi2);

      continue;
    }

    if (type === 'quick-arc') {
      ctx.arc(0, 0, props.r, 0, this.pi2);

      continue;
    }

    if (type === 'arcTo') {
      ctx.arcTo(props.x1, props.y1, props.x2, props.y2, props.r);

      continue;
    }

    if (type === 'anticlockwise-ellipse') {
      this.save();
      this.translate(props.x, props.y);
      this.rotate(props.rotation);
      this.scale(props.radiusX, props.radiusY);
      this.arc(0, 0, 1, props.startAngle, props.endAngle, true);
      this.restore();

      continue;
    }

    if (type === 'ellipse') {
      this.save();
      this.translate(props.x, props.y);
      this.rotate(props.rotation);
      this.scale(props.radiusX, props.radiusY);
      this.arc(0, 0, 1, props.startAngle, props.endAngle);
      this.restore();

      continue;
    }

    if (type === 'full-ellipse') {
      this.save();
      this.translate(props.x, props.y);
      this.rotate(props.rotation);
      this.scale(props.radiusX, props.radiusY);
      this.arc(0, 0, 1, 0, this.pi2);
      this.restore();

      continue;
    }

    if (type === 'quick-ellipse') {
      this.save();
      this.translate(props.x, props.y);
      this.scale(props.radiusX, props.radiusY);
      this.arc(0, 0, 1, 0, this.pi2);
      this.restore();

      continue;
    }

    if (type === 'globalCompositeOperation') {
      this.globalCompositeOperationStack.push(ctx.globalCompositeOperation);
      ctx.globalCompositeOperation = props.value;

      continue;
    }

    if (type === 'endGlobalCompositeOperation') {
      ctx.globalCompositeOperation = this.globalCompositeOperationStack.pop();

      continue;
    }

    if (type === 'fill') {
      ctx.fill();

      continue;
    }

    if (type === 'stroke') {
      ctx.stroke();

      continue;
    }

    if (type === 'beginClip') {
      ctx.save();
      ctx.beginPath();

      continue;
    }

    if (type === 'clip') {
      ctx.clip();

      continue;
    }

    if (type === 'endClip') {
      ctx.restore();

      continue;
    }

    if (type === 'beginPath') {
      ctx.beginPath();

      continue;
    }

    if (type === 'closePath') {
      ctx.closePath();

      continue;
    }

    if (type === 'globalAlpha') {
      this.globalAlphaStack.push(ctx.globalAlpha);
      ctx.globalAlpha *= props.value;

      continue;
    }

    if (type === 'endGlobalAlpha') {
      ctx.globalAlpha = this.globalAlphaStack.pop();

      continue;
    }

    if (type === 'hitRegion') {
      this.mouseRegions.push({
        id: props.id,
        points: transformPoints(props.points, this.transformStack[this.transformStack.length - 1])
      });

      continue;
    }

    if (type === 'imageSmoothingEnabled') {
      this.imageSmoothingEnabledStack.push(ctx.imageSmoothingEnabled);
      ctx.imageSmoothingEnabled = props.value;

      continue;
    }

    if (type === 'endImageSmoothingEnabled') {
      ctx.imageSmoothingEnabled = this.imageSmoothingEnabledStack.pop();
      continue;
    }
  }

  return this.applyStyles();
};

Renderer.create = function create(width, height, parent, worker) {
  if (arguments.length > 2) {
    return new Renderer(width, height, parent, worker);
  }
  if (arguments.length === 2) {
    return new Renderer(width, height);
  }
  return new Renderer();
};


Renderer.prototype.resize = function(width, height) {
  //only resize if the sizes are different, because it clears the canvas
  if (this.canvas.width.toString() !== width.toString()) {
    this.canvas.width = width;
  }
  if (this.canvas.height.toString() !== height.toString()) {
    this.canvas.height = height;
  }
};

Renderer.prototype.toImage = function toImage() {
  var Img = require('./Img');
  var img = new Img();
  img.src = this.canvas.toDataURL('image/png');
  return img;
};


Renderer.prototype.hookRender = function hookRender() {

  //If the client has sent a 'ready' command and a tree exists
  if (this.isReady) {
    //fire the mouse event again if it wasn't run
    if (this.lastMouseEvent && !this.ranMouseEvent) {
      this.mouseMove(this.lastMouseEvent);
    }
    //we are browser side, so this should fire the frame synchronously
    this.fireFrame();

  }

  return window.requestAnimationFrame(this.boundHookRenderFunction);
};

Renderer.prototype.hookMouseEvents = function hookMouseEvents() {
  //whenever the mouse moves, report the position
  window.document.addEventListener('mousemove', this.mouseMove.bind(this));

  //only report mousedown on canvas
  this.canvas.addEventListener('mousedown', this.mouseDown.bind(this));

  //mouse up can happen anywhere
  return window.document.addEventListener('mouseup', this.mouseUp.bind(this));
};

Renderer.prototype.mouseMove = function mouseMove(evt) {
  //get bounding rectangle
  var rect = this.canvas.getBoundingClientRect(),
      mousePoint = [0,0],
      region;
  this.lastMouseEvent = evt;
  this.ranMouseEvent = true;

  mousePoint[0] = evt.clientX - rect.left;
  mousePoint[1] = evt.clientY - rect.top;

  for(var i = 0; i < this.mouseRegions.length; i++) {
    region = this.mouseRegions[i];
    if (pointInPolygon(mousePoint, region.points)) {
      this.activeRegions.push(region.id);
      this.mouseRegions.splice(this.mouseRegions.indexOf(region), 1);
      i -= 1;
    }
  }

  this.mouseData.x = mousePoint[0];
  this.mouseData.y = mousePoint[1];
  this.mouseData.state = this.mouseState;
  this.mouseData.activeRegions = this.activeRegions;

  //default event stuff
  evt.preventDefault();
  return false;
};

Renderer.prototype.mouseDown = function mouseMove(evt) {
  //set the mouseState down
  this.mouseState = 'down';
  this.canvas.focus();
  //defer to mouseMove
  return this.mouseMove(evt);
};

Renderer.prototype.mouseUp = function mouseMove(evt) {
  //set the mouse state
  this.mouseState = 'up';
  //defer to mouse move
  return this.mouseMove(evt);
};

Renderer.prototype.hookKeyboardEvents = function hookMouseEvents() {

  //every code in keycode.code needs to be on keyData
  for (var name in keycode.code) {
    if (keycode.code.hasOwnProperty(name)) {
      this.keyData[name] = "up";
    }
  }

  //keydown should only happen ON the canvas
  this.canvas.addEventListener('keydown', this.keyDown.bind(this));

  //but keyup should be captured everywhere
  return window.document.addEventListener('keyup', this.keyUp.bind(this));
};

Renderer.prototype.keyChange = function keyChange(evt) {
  this.sendWorker('key', this.keyData);
  evt.preventDefault();
  return false;
};

Renderer.prototype.keyDown = function keyDown(evt) {
  this.keyData[keycode(evt.keyCode)] = "down";
  return this.keyChange(evt);
};

Renderer.prototype.keyUp = function keyUp(evt) {
  this.keyData[keycode(evt.keyCode)] = "up";
  return this.keyChange(evt);
};

Renderer.prototype.fireFrame = function() {
  this.mouseRegions.splice(0, this.mouseRegions.length);
  this.emit('frame', {});
  this.activeRegions.splice(0, this.activeRegions.length);
  this.ranMouseEvent = false;
  return this;
};

Renderer.prototype.style = function style() {
  var children = [],
      styles = [],
      concat = children.concat,
      len,
      i,
      child,
      name;
  for(i = 0, len = arguments.length; i < len; i++) {
    children.push(arguments[i]);
  }

  for (i = 0, len = children.length; i < len; i++) {
    child = children[i];
    if (child && child.constructor === Array) {
      children = concat.apply([], children);
      child = children[i];
      while(child && child.constructor === Array) {
        children = concat.apply([], children);
        child = children[i];
      }
      len = children.length;
    }
    if (child) {
      styles.push(child);
    }
  }
  for (i = 0; i < styles.length; i++) {
    this.styleQueue.push(styles[i]);
  }
};

Renderer.prototype.applyStyles = function applyStyles() {
  var styleVal, value;
  for(var i = 0; i < this.styleQueue.length; i++) {
    styleVal = this.styleQueue[i];
    for(var name in styleVal) {
      if (styleVal.hasOwnProperty(name)) {
        this.canvas.style[name] = styleVal[name];
      }
    }
  }
  this.styleQueue.splice(0, this.styleQueue.length);
};

Renderer.prototype.ready = function ready() {
  this.isReady = true;
  this.fireFrame();
  return window.requestAnimationFrame(this.hookRender.bind(this));
};

Renderer.prototype.measureText = function measureText(font, text) {
  var oldFont = this.ctx.font,
      result;

  this.ctx.font = font;
  result = this.ctx.measureText(text);
  this.ctx.font = oldFont;
  return result;
};

Object.defineProperty(Renderer.prototype, 'height', {
  get: function() {
    return this.canvas.width;
  },
  enumerable: true,
  configurable: false
});
Object.defineProperty(Renderer.prototype, 'width', {
  get: function() {
    return this.canvas.width;
  },
  enumerable: true,
  configurable: false
});
Object.seal(Renderer);
Object.seal(Renderer.prototype);
module.exports = Renderer;
