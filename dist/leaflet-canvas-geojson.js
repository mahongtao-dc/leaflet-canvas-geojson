(function e(t,n,r){function s(o,u){if(!n[o]){if(!t[o]){var a=typeof require=="function"&&require;if(!u&&a)return a(o,!0);if(i)return i(o,!0);var f=new Error("Cannot find module '"+o+"'");throw f.code="MODULE_NOT_FOUND",f}var l=n[o]={exports:{}};t[o][0].call(l.exports,function(e){var n=t[o][1][e];return s(n?n:e)},l,l.exports,e,t,n,r)}return n[o].exports}var i=typeof require=="function"&&require;for(var o=0;o<r.length;o++)s(r[o]);return s})({1:[function(require,module,exports){
/**
  A Feature should have the following:

  feature = {
    visible : Boolean,
    size : Number, // points only, used for mouse interactions
    geojson : {}
    render : function(context, coordinatesInXY, map) {} // called in feature scope
  }

  geoXY and leaflet will be assigned
**/

L.CanvasGeojsonLayer = L.Class.extend({
  // show layer timing
  debug : false,

  // include events
  includes: [L.Mixin.Events],

  // list of geojson features to draw
  //   - these will draw in order
  features : [],

  // list of current features under the mouse
  intersectList : [],

  // used to calculate pixels moved from center
  lastCenterLL : null,

  // geometry helpers
  utils : require('./utils'),

  // initialize layer
  initialize: function (options) {
    // set options
    options = options || {};
    L.Util.setOptions(this, options);

    // move mouse event handlers to layer scope
    var mouseEvents = ['onMouseOver', 'onMouseMove', 'onMouseOut', 'onClick'];
    mouseEvents.forEach(function(e){
      if( !this.options[e] ) return;
      this[e] = this.options[e];
      delete this.options[e];
    }.bind(this));

    // set canvas and canvas context shortcuts
    this._canvas = this._createCanvas();
    this._ctx = this._canvas.getContext('2d');
  },

  _createCanvas: function() {
    var canvas = document.createElement('canvas');
    canvas.style.position = 'absolute';
    canvas.style.top = 0;
    canvas.style.left = 0;
    canvas.style.pointerEvents = "none";
    canvas.style.zIndex = this.options.zIndex || 0;
    var className = 'leaflet-tile-container leaflet-zoom-animated';
    canvas.setAttribute('class', className);
    return canvas;
  },

  onAdd: function (map) {
    this._map = map;

    // add container with the canvas to the tile pane
    // the container is moved in the oposite direction of the
    // map pane to keep the canvas always in (0, 0)
    var tilePane = this._map._panes.tilePane;
    var _container = L.DomUtil.create('div', 'leaflet-layer');

    _container.appendChild(this._canvas);
    tilePane.appendChild(_container);

    this._container = _container;

    // hack: listen to predrag event launched by dragging to
    // set container in position (0, 0) in screen coordinates
    if (map.dragging.enabled()) {
      map.dragging._draggable.on('predrag', function() {
        var d = map.dragging._draggable;
        L.DomUtil.setPosition(this._canvas, { x: -d._newPos.x, y: -d._newPos.y });
      }, this);
    }

    map.on({
      'viewreset' : this._reset,
      'resize'    : this._reset,
      'move'      : this.render,
      'zoomstart' : this._startZoom,
      'zoomend'   : this._endZoom,
      'mousemove' : this._intersects,
      'click'     : this._intersects
    }, this);

    this._reset();
  },

  _startZoom: function() {
    this._canvas.style.visibility = 'hidden';
    this.zooming = true;
  },

  _endZoom: function () {
    this._canvas.style.visibility = 'visible';
    this.zooming = false;
    setTimeout(this.render.bind(this), 50);
  },

  getCanvas: function() {
    return this._canvas;
  },

  draw: function() {
    this._reset();
  },

  onRemove: function (map) {
    this._container.parentNode.removeChild(this._container);
    map.off({
      'viewreset' : this._reset,
      'resize'    : this._reset,
      'move'      : this.render,
      'zoomstart' : this._startZoom,
      'zoomend'   : this._endZoom,
      'mousemove' : this._intersects,
      'click'     : this._intersects
    }, this);
  },

  addTo: function (map) {
    map.addLayer(this);
    return this;
  },

  _reset: function () {
    // reset actual canvas size
    var size = this._map.getSize();
    this._canvas.width = size.x;
    this._canvas.height = size.y;

    this.clearCache();

    this.render();
  },

  // clear each features cache
  clearCache : function() {
    // kill the feature point cache
    for( var i = 0; i < this.features.length; i++ ) {
      this.clearFeatureCache( this.features[i] );
    }
  },

  clearFeatureCache : function(feature) {
    if( !feature.cache ) return;
    feature.cache.geoXY = null;
  },

  // redraw all features.  This does not handle clearing the canvas or setting
  // the canvas correct position.  That is handled by render
  redraw: function(diff) {
    // objects should keep track of last bbox and zoom of map
    // if this hasn't changed the ll -> container pt is not needed
    var bounds = this._map.getBounds();
    var zoom = this._map.getZoom();

    if( this.debug ) t = new Date().getTime();

    for( var i = 0; i < this.features.length; i++ ) {
      this.redrawFeature(this.features[i], bounds, zoom, diff);
    }

    if( this.debug ) console.log('Render time: '+(new Date().getTime() - t)+'ms; avg: '+
      ((new Date().getTime() - t) / this.features.length)+'ms');
  },

  // redraw an individual feature
  redrawFeature : function(feature, bounds, zoom, diff) {
    //if( feature.geojson.properties.debug ) debugger;

    // ignore anything flagged as hidden
    // we do need to clear the cache in this case
    if( !feature.visible ) {
      this.clearFeatureCache(feature);
      return;
    }

    // now lets check cache to see if we need to reproject the
    // xy coordinates
    var reproject = true;
    if( feature.cache ) {
      if( feature.cache.zoom == zoom && feature.cache.geoXY ) {
        reproject = false;
      }
    }

    // actually project to xy if needed
    if( reproject ) {
      this._calcGeoXY(feature, zoom);
    }  // end reproject

    // if this was a simple pan event (a diff was provided) and we did not reproject
    // move the feature by diff x/y
    if( diff && !reproject ) {
      if( feature.geojson.geometry.type == 'Point' ) {

        feature.cache.geoXY.x += diff.x;
        feature.cache.geoXY.y += diff.y;

      } else if( feature.geojson.geometry.type == 'LineString' ) {

        this.utils.moveLine(feature.cache.geoXY, diff);

      } else if ( feature.geojson.geometry.type == 'Polygon' ) {
        this.utils.moveLine(feature.cache.geoXY, diff);
      } else if ( feature.geojson.geometry.type == 'MultiPolygon' ) {
        for( var i = 0; i < feature.cache.geoXY.length; i++ ) {
          this.utils.moveLine(feature.cache.geoXY[i], diff);
        }
      }
    }

    // ignore anything not in bounds
    if( feature.geojson.geometry.type == 'Point' ) {
      if( !bounds.contains(feature.latlng) ) {
        return;
      }
    } else if( feature.geojson.geometry.type == 'MultiPolygon' ) {

      // just make sure at least one polygon is within range
      var found = false;
      for( var i = 0; i < feature.bounds.length; i++ ) {
        if( bounds.contains(feature.bounds[i]) || bounds.intersects(feature.bounds[i]) ) {
          found = true;
          break;
        }
      }
      if( !found ) return;

    } else {
      if( !bounds.contains(feature.bounds) && !bounds.intersects(feature.bounds) ) {
        return;
      }
    }

    // call feature render function in feature scope; feature is passed as well
    feature.render.call(feature, this._ctx, feature.cache.geoXY, this._map, feature);
  },

  _calcGeoXY : function(feature, zoom) {
    // make sure we have a cache namespace and set the zoom level
    if( !feature.cache ) feature.cache = {};
    feature.cache.zoom = zoom;

    if( feature.geojson.geometry.type == 'Point' ) {

      feature.cache.geoXY = this._map.latLngToContainerPoint([
          feature.geojson.geometry.coordinates[1],
          feature.geojson.geometry.coordinates[0]
      ]);

      if( feature.size ) {
        feature.cache.geoXY[0] = feature.cache.geoXY[0] - feature.size / 2;
        feature.cache.geoXY[1] = feature.cache.geoXY[1] - feature.size / 2;
      }

    } else if( feature.geojson.geometry.type == 'LineString' ) {
      feature.cache.geoXY = this.utils.projectLine(feature.geojson.geometry.coordinates, this._map);

    } else if ( feature.geojson.geometry.type == 'Polygon' ) {
      feature.cache.geoXY = this.utils.projectLine(feature.geojson.geometry.coordinates[0], this._map);
    } else if ( feature.geojson.geometry.type == 'MultiPolygon' ) {
      feature.cache.geoXY = [];
      for( var i = 0; i < feature.geojson.geometry.coordinates.length; i++ ) {
        feature.cache.geoXY.push(this.utils.projectLine(feature.geojson.geometry.coordinates[i][0], this._map));
      }
    }

  },

  addFeatures : function(features) {
    for( var i = 0; i < this.features.length; i++ ) {
      this.addFeature(this.features[i]);
    }
  },

  addFeature : function(feature, bottom) {
    if( !feature.geojson ) return;
    if( !feature.geojson.geometry ) return;

    if( typeof feature.visible === 'undefined' ) feature.visible = true;
    feature.cache = null;

    if( feature.geojson.geometry.type == 'LineString' ) {
      feature.bounds = this.utils.calcBounds(feature.geojson.geometry.coordinates);

    } else if ( feature.geojson.geometry.type == 'Polygon' ) {
      // TODO: we only support outer rings out the moment, no inner rings.  Thus coordinates[0]
      feature.bounds = this.utils.calcBounds(feature.geojson.geometry.coordinates[0]);

    } else if ( feature.geojson.geometry.type == 'Point' ) {
      feature.latlng = L.latLng(feature.geojson.geometry.coordinates[1], feature.geojson.geometry.coordinates[0]);
    } else if ( feature.geojson.geometry.type == 'MultiPolygon' ) {
      feature.bounds = [];
      for( var i = 0; i < feature.geojson.geometry.coordinates.length; i++  ) {
        feature.bounds.push(this.utils.calcBounds(feature.geojson.geometry.coordinates[i][0]));
      }
    } else {
      console.log('GeoJSON feature type "'+feature.geojson.geometry.type+'" not supported.');
      console.log(feature.geojson);
      return;
    }

    if( bottom ) { // bottom or index
      if( typeof bottom === 'number') this.features.splice(bottom, 0, feature);
      else this.features.unshift(feature);
    } else {
      this.features.push(feature);
    }
  },

  addFeatureBottom : function(feature) {
    this.addFeature(feature, true);
  },

  // returns true if re-render required.  ie the feature was visible;
  removeFeature : function(feature) {
    var index = this.features.indexOf(feature);
    if( index == -1 ) return;

    this.splice(index, 1);

    if( this.feature.visible ) return true;
    return false;
  },

  // get layer feature via geojson object
  getFeatureForGeojson : function(geojson) {
    for( var i = 0; i < this.features.length; i++ ) {
      if( this.features[i].geojson == geojson ) return this.features[i];
    }

    return null;
  },

  render: function(e) {
    var t, diff
    if( this.debug ) t = new Date().getTime();

    var diff = null;
    if( e && e.type == 'move' ) {
      var center = this._map.getCenter();

      var pt = this._map.latLngToContainerPoint(center);
      if( this.lastCenterLL ) {
        var lastXy = this._map.latLngToContainerPoint(this.lastCenterLL);
        diff = {
          x : lastXy.x - pt.x,
          y : lastXy.y - pt.y
        }
      }

      this.lastCenterLL = center;
    }

    var topLeft = this._map.containerPointToLayerPoint([0, 0]);
    L.DomUtil.setPosition(this._canvas, topLeft);

    var canvas = this.getCanvas();
    var ctx = canvas.getContext('2d');

    // clear canvas
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    if( !this.zooming ) this.redraw(diff);

    if( this.debug ) {
      diff = new Date().getTime() - t;

      var c = 0;
      for( var i = 0; i < this.features.length; i++ ) {
        if( !this.features[i].cache.geoXY ) continue;
        if( Array.isArray(this.features[i].cache.geoXY) ) c += this.features[i].cache.geoXY.length;
      }

      console.log('Rendered '+c+' pts in '+diff+'ms');
    }
  },

  /*
    return list of all intersecting geometry regradless is currently visible

    pxRadius - is for lines and points only.  Basically how far off the line or
    or point a latlng can be and still be considered intersecting.  This is
    given in px as it is compensating for user intent with mouse click or touch.
    The point must lay inside to polygon for a match.
  */
  getAllIntersectingGeometry : function(latlng, pxRadius) {
    var mpp = this.utils.metersPerPx(latlng, this._map);
    var r = mpp * (pxRadius || 5); // 5 px radius buffer;

    var center = {
      type : 'Point',
      coordinates : [latlng.lng, latlng.lat]
    };
    var zoom = this._map.getZoom();
    var containerPoint = this._map.latLngToContainerPoint(latlng);

    var f;
    var intersects = [];

    for( var i = 0; i < this.features.length; i++ ) {
      f = this.features[i];

      if( !f.geojson.geometry ) continue;

      // check the bounding box for intersection first
      if( !this._isInBounds(feature, latlng) ) continue;

      // see if we need to recalc the x,y screen coordinate cache
      if( !f.cache ) this._calcGeoXY(f, zoom);
      else if( !f.cache.geoXY ) this._calcGeoXY(f, zoom);

      if( this.utils.geometryWithinRadius(f.geojson.geometry, f.cache.geoXY, center, containerPoint, r) ) {
        intersects.push(f);
      }
    }

    return intersects;
  },

  // returns true if in bounds or unknown
  _isInBounds : function(feature, latlng) {
    if( feature.bounds ) {
      if( Array.isArray(feature.bounds) ) {

        for( var i = 0; i < feature.bounds.length; i++ ) {
          if( feature.bounds[i].contains(latlng) ) return true;
        }

      } else if ( feature.bounds.contains(latlng) ) {
        return true;
      }

      return false;
    }
    return true;
  },

  // get the meters per px and a certain point;
  getMetersPerPx : function(latlng) {
    return this.utils.metersPerPx(latlng, this._map);
  },

  _intersects : function(e) {
    var t = new Date().getTime();
    var mpp = this.getMetersPerPx(e.latlng);
    var r = mpp * 5; // 5 px radius buffer;

    var center = {
      type : 'Point',
      coordinates : [e.latlng.lng, e.latlng.lat]
    };

    var f;
    var intersects = [];

    for( var i = 0; i < this.features.length; i++ ) {
      f = this.features[i];

      if( !f.visible ) continue;
      if( !f.geojson.geometry ) continue;
      if( !f.cache ) continue;
      if( !f.cache.geoXY ) continue;
      if( !this._isInBounds(f, e.latlng) ) continue;

      if( this.utils.geometryWithinRadius(f.geojson.geometry, f.cache.geoXY, center, e.containerPoint, f.size ? (f.size * mpp) : r) ) {
        intersects.push(f.geojson);
      }

    }

    if( e.type == 'click' && this.onClick ) {
      this.onClick(intersects);
      return;
    }

    var mouseover = [], mouseout = [], mousemove = [];

    var changed = false;
    for( var i = 0; i < intersects.length; i++ ) {
      if( this.intersectList.indexOf(intersects[i]) > -1 ) {
        mousemove.push(intersects[i]);
      } else {
        changed = true;
        mouseover.push(intersects[i]);
      }
    }

    for( var i = 0; i < this.intersectList.length; i++ ) {
      if( intersects.indexOf(this.intersectList[i]) == -1 ) {
        changed = true;
        mouseout.push(this.intersectList[i]);
      }
    }

    this.intersectList = intersects;

    if( this.onMouseOver && mouseover.length > 0 ) this.onMouseOver.call(this, mouseover, e);
    if( this.onMouseMove && mousemove.length > 0 ) this.onMouseMove.call(this, mousemove, e);
    if( this.onMouseOut && mouseout.length > 0 ) this.onMouseOut.call(this, mouseout, e);

    if( this.debug ) console.log('intersects time: '+(new Date().getTime() - t)+'ms');

    if( changed ) this.render();
  }
});

},{"./utils":2}],2:[function(require,module,exports){
module.exports = {
  moveLine : function(coords, diff) {
    var i; len = coords.length;
    for( i = 0; i < len; i++ ) {
      coords[i].x += diff.x;
      coords[i].y += diff.y;
    }
  },

  projectLine : function(coords, map) {
    var xyLine = [];

    for( var i = 0; i < coords.length; i++ ) {
      xyLine.push(map.latLngToContainerPoint([
          coords[i][1], coords[i][0]
      ]));
    }

    return xyLine;
  },

  calcBounds : function(coords) {
    var xmin = coords[0][1];
    var xmax = coords[0][1];
    var ymin = coords[0][0];
    var ymax = coords[0][0];

    for( var i = 1; i < coords.length; i++ ) {
      if( xmin > coords[i][1] ) xmin = coords[i][1];
      if( xmax < coords[i][1] ) xmax = coords[i][1];

      if( ymin > coords[i][0] ) ymin = coords[i][0];
      if( ymax < coords[i][0] ) ymax = coords[i][0];
    }

    var southWest = L.latLng(xmin-.01, ymin-.01);
    var northEast = L.latLng(xmax+.01, ymax+.01);

    return L.latLngBounds(southWest, northEast);
  },

  geometryWithinRadius : function(geometry, xyPoints, center, xyPoint, radius) {
    if (geometry.type == 'Point') {
      return this.pointDistance(geometry, center) <= radius;
    } else if (geometry.type == 'LineString' ) {

      for( var i = 1; i < xyPoints.length; i++ ) {
        if( this.lineIntersectsCircle(xyPoints[i-1], xyPoints[i], xyPoint, 3) ) {
          return true;
        }
      }

      return false;
    } else if (geometry.type == 'Polygon' || geometry.type == 'MultiPolygon') {
      return this.pointInPolygon(center, geometry);
    }
  },

  // http://math.stackexchange.com/questions/275529/check-if-line-intersects-with-circles-perimeter
  // https://en.wikipedia.org/wiki/Distance_from_a_point_to_a_line
  // [lng x, lat, y]
  lineIntersectsCircle : function(lineP1, lineP2, point, radius) {
    var distance =
      Math.abs(
        ((lineP2.y - lineP1.y)*point.x) - ((lineP2.x - lineP1.x)*point.y) + (lineP2.x*lineP1.y) - (lineP2.y*lineP1.x)
      ) /
      Math.sqrt(
        Math.pow(lineP2.y - lineP1.y, 2) + Math.pow(lineP2.x - lineP1.x, 2)
      );
    return distance <= radius;
  },

  // http://wiki.openstreetmap.org/wiki/Zoom_levels
  // http://stackoverflow.com/questions/27545098/leaflet-calculating-meters-per-pixel-at-zoom-level
  metersPerPx : function(ll, map) {
    var pointC = map.latLngToContainerPoint(ll); // convert to containerpoint (pixels)
    var pointX = [pointC.x + 1, pointC.y]; // add one pixel to x

    // convert containerpoints to latlng's
    var latLngC = map.containerPointToLatLng(pointC);
    var latLngX = map.containerPointToLatLng(pointX);

    var distanceX = latLngC.distanceTo(latLngX); // calculate distance between c and x (latitude)
    return distanceX;
  },

  // from http://www.movable-type.co.uk/scripts/latlong.html
  pointDistance : function (pt1, pt2) {
    var lon1 = pt1.coordinates[0],
      lat1 = pt1.coordinates[1],
      lon2 = pt2.coordinates[0],
      lat2 = pt2.coordinates[1],
      dLat = this.numberToRadius(lat2 - lat1),
      dLon = this.numberToRadius(lon2 - lon1),
      a = Math.pow(Math.sin(dLat / 2), 2) + Math.cos(this.numberToRadius(lat1))
        * Math.cos(this.numberToRadius(lat2)) * Math.pow(Math.sin(dLon / 2), 2),
      c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return (6371 * c) * 1000; // returns meters
  },

  pointInPolygon : function (p, poly) {
    var coords = (poly.type == "Polygon") ? [ poly.coordinates ] : poly.coordinates

    var insideBox = false
    for (var i = 0; i < coords.length; i++) {
      if (this.pointInBoundingBox(p, this.boundingBoxAroundPolyCoords(coords[i]))) insideBox = true
    }
    if (!insideBox) return false

    var insidePoly = false
    for (var i = 0; i < coords.length; i++) {
      if (this.pnpoly(p.coordinates[1], p.coordinates[0], coords[i])) insidePoly = true
    }

    return insidePoly
  },

  pointInBoundingBox : function (point, bounds) {
    return !(point.coordinates[1] < bounds[0][0] || point.coordinates[1] > bounds[1][0] || point.coordinates[0] < bounds[0][1] || point.coordinates[0] > bounds[1][1])
  },

  boundingBoxAroundPolyCoords : function(coords) {
    var xAll = [], yAll = []

    for (var i = 0; i < coords[0].length; i++) {
      xAll.push(coords[0][i][1])
      yAll.push(coords[0][i][0])
    }

    xAll = xAll.sort(function (a,b) { return a - b })
    yAll = yAll.sort(function (a,b) { return a - b })

    return [ [xAll[0], yAll[0]], [xAll[xAll.length - 1], yAll[yAll.length - 1]] ]
  },

  // Point in Polygon
  // http://www.ecse.rpi.edu/Homepages/wrf/Research/Short_Notes/pnpoly.html#Listing the Vertices
  pnpoly : function(x,y,coords) {
    var vert = [ [0,0] ]

    for (var i = 0; i < coords.length; i++) {
      for (var j = 0; j < coords[i].length; j++) {
        vert.push(coords[i][j])
      }
      vert.push(coords[i][0])
      vert.push([0,0])
    }

    var inside = false
    for (var i = 0, j = vert.length - 1; i < vert.length; j = i++) {
      if (((vert[i][0] > y) != (vert[j][0] > y)) && (x < (vert[j][1] - vert[i][1]) * (y - vert[i][0]) / (vert[j][0] - vert[i][0]) + vert[i][1])) inside = !inside
    }

    return inside
  },

  numberToRadius : function (number) {
    return number * Math.PI / 180;
  }
};

},{}]},{},[1])
//# sourceMappingURL=data:application/json;charset:utf-8;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbIi4uLy4uLy4uLy4uLy4uL3Vzci9sb2NhbC9saWIvbm9kZV9tb2R1bGVzL2Jyb3dzZXJpZnkvbm9kZV9tb2R1bGVzL2Jyb3dzZXItcGFjay9fcHJlbHVkZS5qcyIsInNyYy9sYXllciIsInNyYy91dGlscy5qcyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiQUFBQTtBQ0FBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FDeGdCQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBIiwiZmlsZSI6ImdlbmVyYXRlZC5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzQ29udGVudCI6WyIoZnVuY3Rpb24gZSh0LG4scil7ZnVuY3Rpb24gcyhvLHUpe2lmKCFuW29dKXtpZighdFtvXSl7dmFyIGE9dHlwZW9mIHJlcXVpcmU9PVwiZnVuY3Rpb25cIiYmcmVxdWlyZTtpZighdSYmYSlyZXR1cm4gYShvLCEwKTtpZihpKXJldHVybiBpKG8sITApO3ZhciBmPW5ldyBFcnJvcihcIkNhbm5vdCBmaW5kIG1vZHVsZSAnXCIrbytcIidcIik7dGhyb3cgZi5jb2RlPVwiTU9EVUxFX05PVF9GT1VORFwiLGZ9dmFyIGw9bltvXT17ZXhwb3J0czp7fX07dFtvXVswXS5jYWxsKGwuZXhwb3J0cyxmdW5jdGlvbihlKXt2YXIgbj10W29dWzFdW2VdO3JldHVybiBzKG4/bjplKX0sbCxsLmV4cG9ydHMsZSx0LG4scil9cmV0dXJuIG5bb10uZXhwb3J0c312YXIgaT10eXBlb2YgcmVxdWlyZT09XCJmdW5jdGlvblwiJiZyZXF1aXJlO2Zvcih2YXIgbz0wO288ci5sZW5ndGg7bysrKXMocltvXSk7cmV0dXJuIHN9KSIsIi8qKlxuICBBIEZlYXR1cmUgc2hvdWxkIGhhdmUgdGhlIGZvbGxvd2luZzpcblxuICBmZWF0dXJlID0ge1xuICAgIHZpc2libGUgOiBCb29sZWFuLFxuICAgIHNpemUgOiBOdW1iZXIsIC8vIHBvaW50cyBvbmx5LCB1c2VkIGZvciBtb3VzZSBpbnRlcmFjdGlvbnNcbiAgICBnZW9qc29uIDoge31cbiAgICByZW5kZXIgOiBmdW5jdGlvbihjb250ZXh0LCBjb29yZGluYXRlc0luWFksIG1hcCkge30gLy8gY2FsbGVkIGluIGZlYXR1cmUgc2NvcGVcbiAgfVxuXG4gIGdlb1hZIGFuZCBsZWFmbGV0IHdpbGwgYmUgYXNzaWduZWRcbioqL1xuXG5MLkNhbnZhc0dlb2pzb25MYXllciA9IEwuQ2xhc3MuZXh0ZW5kKHtcbiAgLy8gc2hvdyBsYXllciB0aW1pbmdcbiAgZGVidWcgOiBmYWxzZSxcblxuICAvLyBpbmNsdWRlIGV2ZW50c1xuICBpbmNsdWRlczogW0wuTWl4aW4uRXZlbnRzXSxcblxuICAvLyBsaXN0IG9mIGdlb2pzb24gZmVhdHVyZXMgdG8gZHJhd1xuICAvLyAgIC0gdGhlc2Ugd2lsbCBkcmF3IGluIG9yZGVyXG4gIGZlYXR1cmVzIDogW10sXG5cbiAgLy8gbGlzdCBvZiBjdXJyZW50IGZlYXR1cmVzIHVuZGVyIHRoZSBtb3VzZVxuICBpbnRlcnNlY3RMaXN0IDogW10sXG5cbiAgLy8gdXNlZCB0byBjYWxjdWxhdGUgcGl4ZWxzIG1vdmVkIGZyb20gY2VudGVyXG4gIGxhc3RDZW50ZXJMTCA6IG51bGwsXG5cbiAgLy8gZ2VvbWV0cnkgaGVscGVyc1xuICB1dGlscyA6IHJlcXVpcmUoJy4vdXRpbHMnKSxcblxuICAvLyBpbml0aWFsaXplIGxheWVyXG4gIGluaXRpYWxpemU6IGZ1bmN0aW9uIChvcHRpb25zKSB7XG4gICAgLy8gc2V0IG9wdGlvbnNcbiAgICBvcHRpb25zID0gb3B0aW9ucyB8fCB7fTtcbiAgICBMLlV0aWwuc2V0T3B0aW9ucyh0aGlzLCBvcHRpb25zKTtcblxuICAgIC8vIG1vdmUgbW91c2UgZXZlbnQgaGFuZGxlcnMgdG8gbGF5ZXIgc2NvcGVcbiAgICB2YXIgbW91c2VFdmVudHMgPSBbJ29uTW91c2VPdmVyJywgJ29uTW91c2VNb3ZlJywgJ29uTW91c2VPdXQnLCAnb25DbGljayddO1xuICAgIG1vdXNlRXZlbnRzLmZvckVhY2goZnVuY3Rpb24oZSl7XG4gICAgICBpZiggIXRoaXMub3B0aW9uc1tlXSApIHJldHVybjtcbiAgICAgIHRoaXNbZV0gPSB0aGlzLm9wdGlvbnNbZV07XG4gICAgICBkZWxldGUgdGhpcy5vcHRpb25zW2VdO1xuICAgIH0uYmluZCh0aGlzKSk7XG5cbiAgICAvLyBzZXQgY2FudmFzIGFuZCBjYW52YXMgY29udGV4dCBzaG9ydGN1dHNcbiAgICB0aGlzLl9jYW52YXMgPSB0aGlzLl9jcmVhdGVDYW52YXMoKTtcbiAgICB0aGlzLl9jdHggPSB0aGlzLl9jYW52YXMuZ2V0Q29udGV4dCgnMmQnKTtcbiAgfSxcblxuICBfY3JlYXRlQ2FudmFzOiBmdW5jdGlvbigpIHtcbiAgICB2YXIgY2FudmFzID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudCgnY2FudmFzJyk7XG4gICAgY2FudmFzLnN0eWxlLnBvc2l0aW9uID0gJ2Fic29sdXRlJztcbiAgICBjYW52YXMuc3R5bGUudG9wID0gMDtcbiAgICBjYW52YXMuc3R5bGUubGVmdCA9IDA7XG4gICAgY2FudmFzLnN0eWxlLnBvaW50ZXJFdmVudHMgPSBcIm5vbmVcIjtcbiAgICBjYW52YXMuc3R5bGUuekluZGV4ID0gdGhpcy5vcHRpb25zLnpJbmRleCB8fCAwO1xuICAgIHZhciBjbGFzc05hbWUgPSAnbGVhZmxldC10aWxlLWNvbnRhaW5lciBsZWFmbGV0LXpvb20tYW5pbWF0ZWQnO1xuICAgIGNhbnZhcy5zZXRBdHRyaWJ1dGUoJ2NsYXNzJywgY2xhc3NOYW1lKTtcbiAgICByZXR1cm4gY2FudmFzO1xuICB9LFxuXG4gIG9uQWRkOiBmdW5jdGlvbiAobWFwKSB7XG4gICAgdGhpcy5fbWFwID0gbWFwO1xuXG4gICAgLy8gYWRkIGNvbnRhaW5lciB3aXRoIHRoZSBjYW52YXMgdG8gdGhlIHRpbGUgcGFuZVxuICAgIC8vIHRoZSBjb250YWluZXIgaXMgbW92ZWQgaW4gdGhlIG9wb3NpdGUgZGlyZWN0aW9uIG9mIHRoZVxuICAgIC8vIG1hcCBwYW5lIHRvIGtlZXAgdGhlIGNhbnZhcyBhbHdheXMgaW4gKDAsIDApXG4gICAgdmFyIHRpbGVQYW5lID0gdGhpcy5fbWFwLl9wYW5lcy50aWxlUGFuZTtcbiAgICB2YXIgX2NvbnRhaW5lciA9IEwuRG9tVXRpbC5jcmVhdGUoJ2RpdicsICdsZWFmbGV0LWxheWVyJyk7XG5cbiAgICBfY29udGFpbmVyLmFwcGVuZENoaWxkKHRoaXMuX2NhbnZhcyk7XG4gICAgdGlsZVBhbmUuYXBwZW5kQ2hpbGQoX2NvbnRhaW5lcik7XG5cbiAgICB0aGlzLl9jb250YWluZXIgPSBfY29udGFpbmVyO1xuXG4gICAgLy8gaGFjazogbGlzdGVuIHRvIHByZWRyYWcgZXZlbnQgbGF1bmNoZWQgYnkgZHJhZ2dpbmcgdG9cbiAgICAvLyBzZXQgY29udGFpbmVyIGluIHBvc2l0aW9uICgwLCAwKSBpbiBzY3JlZW4gY29vcmRpbmF0ZXNcbiAgICBpZiAobWFwLmRyYWdnaW5nLmVuYWJsZWQoKSkge1xuICAgICAgbWFwLmRyYWdnaW5nLl9kcmFnZ2FibGUub24oJ3ByZWRyYWcnLCBmdW5jdGlvbigpIHtcbiAgICAgICAgdmFyIGQgPSBtYXAuZHJhZ2dpbmcuX2RyYWdnYWJsZTtcbiAgICAgICAgTC5Eb21VdGlsLnNldFBvc2l0aW9uKHRoaXMuX2NhbnZhcywgeyB4OiAtZC5fbmV3UG9zLngsIHk6IC1kLl9uZXdQb3MueSB9KTtcbiAgICAgIH0sIHRoaXMpO1xuICAgIH1cblxuICAgIG1hcC5vbih7XG4gICAgICAndmlld3Jlc2V0JyA6IHRoaXMuX3Jlc2V0LFxuICAgICAgJ3Jlc2l6ZScgICAgOiB0aGlzLl9yZXNldCxcbiAgICAgICdtb3ZlJyAgICAgIDogdGhpcy5yZW5kZXIsXG4gICAgICAnem9vbXN0YXJ0JyA6IHRoaXMuX3N0YXJ0Wm9vbSxcbiAgICAgICd6b29tZW5kJyAgIDogdGhpcy5fZW5kWm9vbSxcbiAgICAgICdtb3VzZW1vdmUnIDogdGhpcy5faW50ZXJzZWN0cyxcbiAgICAgICdjbGljaycgICAgIDogdGhpcy5faW50ZXJzZWN0c1xuICAgIH0sIHRoaXMpO1xuXG4gICAgdGhpcy5fcmVzZXQoKTtcbiAgfSxcblxuICBfc3RhcnRab29tOiBmdW5jdGlvbigpIHtcbiAgICB0aGlzLl9jYW52YXMuc3R5bGUudmlzaWJpbGl0eSA9ICdoaWRkZW4nO1xuICAgIHRoaXMuem9vbWluZyA9IHRydWU7XG4gIH0sXG5cbiAgX2VuZFpvb206IGZ1bmN0aW9uICgpIHtcbiAgICB0aGlzLl9jYW52YXMuc3R5bGUudmlzaWJpbGl0eSA9ICd2aXNpYmxlJztcbiAgICB0aGlzLnpvb21pbmcgPSBmYWxzZTtcbiAgICBzZXRUaW1lb3V0KHRoaXMucmVuZGVyLmJpbmQodGhpcyksIDUwKTtcbiAgfSxcblxuICBnZXRDYW52YXM6IGZ1bmN0aW9uKCkge1xuICAgIHJldHVybiB0aGlzLl9jYW52YXM7XG4gIH0sXG5cbiAgZHJhdzogZnVuY3Rpb24oKSB7XG4gICAgdGhpcy5fcmVzZXQoKTtcbiAgfSxcblxuICBvblJlbW92ZTogZnVuY3Rpb24gKG1hcCkge1xuICAgIHRoaXMuX2NvbnRhaW5lci5wYXJlbnROb2RlLnJlbW92ZUNoaWxkKHRoaXMuX2NvbnRhaW5lcik7XG4gICAgbWFwLm9mZih7XG4gICAgICAndmlld3Jlc2V0JyA6IHRoaXMuX3Jlc2V0LFxuICAgICAgJ3Jlc2l6ZScgICAgOiB0aGlzLl9yZXNldCxcbiAgICAgICdtb3ZlJyAgICAgIDogdGhpcy5yZW5kZXIsXG4gICAgICAnem9vbXN0YXJ0JyA6IHRoaXMuX3N0YXJ0Wm9vbSxcbiAgICAgICd6b29tZW5kJyAgIDogdGhpcy5fZW5kWm9vbSxcbiAgICAgICdtb3VzZW1vdmUnIDogdGhpcy5faW50ZXJzZWN0cyxcbiAgICAgICdjbGljaycgICAgIDogdGhpcy5faW50ZXJzZWN0c1xuICAgIH0sIHRoaXMpO1xuICB9LFxuXG4gIGFkZFRvOiBmdW5jdGlvbiAobWFwKSB7XG4gICAgbWFwLmFkZExheWVyKHRoaXMpO1xuICAgIHJldHVybiB0aGlzO1xuICB9LFxuXG4gIF9yZXNldDogZnVuY3Rpb24gKCkge1xuICAgIC8vIHJlc2V0IGFjdHVhbCBjYW52YXMgc2l6ZVxuICAgIHZhciBzaXplID0gdGhpcy5fbWFwLmdldFNpemUoKTtcbiAgICB0aGlzLl9jYW52YXMud2lkdGggPSBzaXplLng7XG4gICAgdGhpcy5fY2FudmFzLmhlaWdodCA9IHNpemUueTtcblxuICAgIHRoaXMuY2xlYXJDYWNoZSgpO1xuXG4gICAgdGhpcy5yZW5kZXIoKTtcbiAgfSxcblxuICAvLyBjbGVhciBlYWNoIGZlYXR1cmVzIGNhY2hlXG4gIGNsZWFyQ2FjaGUgOiBmdW5jdGlvbigpIHtcbiAgICAvLyBraWxsIHRoZSBmZWF0dXJlIHBvaW50IGNhY2hlXG4gICAgZm9yKCB2YXIgaSA9IDA7IGkgPCB0aGlzLmZlYXR1cmVzLmxlbmd0aDsgaSsrICkge1xuICAgICAgdGhpcy5jbGVhckZlYXR1cmVDYWNoZSggdGhpcy5mZWF0dXJlc1tpXSApO1xuICAgIH1cbiAgfSxcblxuICBjbGVhckZlYXR1cmVDYWNoZSA6IGZ1bmN0aW9uKGZlYXR1cmUpIHtcbiAgICBpZiggIWZlYXR1cmUuY2FjaGUgKSByZXR1cm47XG4gICAgZmVhdHVyZS5jYWNoZS5nZW9YWSA9IG51bGw7XG4gIH0sXG5cbiAgLy8gcmVkcmF3IGFsbCBmZWF0dXJlcy4gIFRoaXMgZG9lcyBub3QgaGFuZGxlIGNsZWFyaW5nIHRoZSBjYW52YXMgb3Igc2V0dGluZ1xuICAvLyB0aGUgY2FudmFzIGNvcnJlY3QgcG9zaXRpb24uICBUaGF0IGlzIGhhbmRsZWQgYnkgcmVuZGVyXG4gIHJlZHJhdzogZnVuY3Rpb24oZGlmZikge1xuICAgIC8vIG9iamVjdHMgc2hvdWxkIGtlZXAgdHJhY2sgb2YgbGFzdCBiYm94IGFuZCB6b29tIG9mIG1hcFxuICAgIC8vIGlmIHRoaXMgaGFzbid0IGNoYW5nZWQgdGhlIGxsIC0+IGNvbnRhaW5lciBwdCBpcyBub3QgbmVlZGVkXG4gICAgdmFyIGJvdW5kcyA9IHRoaXMuX21hcC5nZXRCb3VuZHMoKTtcbiAgICB2YXIgem9vbSA9IHRoaXMuX21hcC5nZXRab29tKCk7XG5cbiAgICBpZiggdGhpcy5kZWJ1ZyApIHQgPSBuZXcgRGF0ZSgpLmdldFRpbWUoKTtcblxuICAgIGZvciggdmFyIGkgPSAwOyBpIDwgdGhpcy5mZWF0dXJlcy5sZW5ndGg7IGkrKyApIHtcbiAgICAgIHRoaXMucmVkcmF3RmVhdHVyZSh0aGlzLmZlYXR1cmVzW2ldLCBib3VuZHMsIHpvb20sIGRpZmYpO1xuICAgIH1cblxuICAgIGlmKCB0aGlzLmRlYnVnICkgY29uc29sZS5sb2coJ1JlbmRlciB0aW1lOiAnKyhuZXcgRGF0ZSgpLmdldFRpbWUoKSAtIHQpKydtczsgYXZnOiAnK1xuICAgICAgKChuZXcgRGF0ZSgpLmdldFRpbWUoKSAtIHQpIC8gdGhpcy5mZWF0dXJlcy5sZW5ndGgpKydtcycpO1xuICB9LFxuXG4gIC8vIHJlZHJhdyBhbiBpbmRpdmlkdWFsIGZlYXR1cmVcbiAgcmVkcmF3RmVhdHVyZSA6IGZ1bmN0aW9uKGZlYXR1cmUsIGJvdW5kcywgem9vbSwgZGlmZikge1xuICAgIC8vaWYoIGZlYXR1cmUuZ2VvanNvbi5wcm9wZXJ0aWVzLmRlYnVnICkgZGVidWdnZXI7XG5cbiAgICAvLyBpZ25vcmUgYW55dGhpbmcgZmxhZ2dlZCBhcyBoaWRkZW5cbiAgICAvLyB3ZSBkbyBuZWVkIHRvIGNsZWFyIHRoZSBjYWNoZSBpbiB0aGlzIGNhc2VcbiAgICBpZiggIWZlYXR1cmUudmlzaWJsZSApIHtcbiAgICAgIHRoaXMuY2xlYXJGZWF0dXJlQ2FjaGUoZmVhdHVyZSk7XG4gICAgICByZXR1cm47XG4gICAgfVxuXG4gICAgLy8gbm93IGxldHMgY2hlY2sgY2FjaGUgdG8gc2VlIGlmIHdlIG5lZWQgdG8gcmVwcm9qZWN0IHRoZVxuICAgIC8vIHh5IGNvb3JkaW5hdGVzXG4gICAgdmFyIHJlcHJvamVjdCA9IHRydWU7XG4gICAgaWYoIGZlYXR1cmUuY2FjaGUgKSB7XG4gICAgICBpZiggZmVhdHVyZS5jYWNoZS56b29tID09IHpvb20gJiYgZmVhdHVyZS5jYWNoZS5nZW9YWSApIHtcbiAgICAgICAgcmVwcm9qZWN0ID0gZmFsc2U7XG4gICAgICB9XG4gICAgfVxuXG4gICAgLy8gYWN0dWFsbHkgcHJvamVjdCB0byB4eSBpZiBuZWVkZWRcbiAgICBpZiggcmVwcm9qZWN0ICkge1xuICAgICAgdGhpcy5fY2FsY0dlb1hZKGZlYXR1cmUsIHpvb20pO1xuICAgIH0gIC8vIGVuZCByZXByb2plY3RcblxuICAgIC8vIGlmIHRoaXMgd2FzIGEgc2ltcGxlIHBhbiBldmVudCAoYSBkaWZmIHdhcyBwcm92aWRlZCkgYW5kIHdlIGRpZCBub3QgcmVwcm9qZWN0XG4gICAgLy8gbW92ZSB0aGUgZmVhdHVyZSBieSBkaWZmIHgveVxuICAgIGlmKCBkaWZmICYmICFyZXByb2plY3QgKSB7XG4gICAgICBpZiggZmVhdHVyZS5nZW9qc29uLmdlb21ldHJ5LnR5cGUgPT0gJ1BvaW50JyApIHtcblxuICAgICAgICBmZWF0dXJlLmNhY2hlLmdlb1hZLnggKz0gZGlmZi54O1xuICAgICAgICBmZWF0dXJlLmNhY2hlLmdlb1hZLnkgKz0gZGlmZi55O1xuXG4gICAgICB9IGVsc2UgaWYoIGZlYXR1cmUuZ2VvanNvbi5nZW9tZXRyeS50eXBlID09ICdMaW5lU3RyaW5nJyApIHtcblxuICAgICAgICB0aGlzLnV0aWxzLm1vdmVMaW5lKGZlYXR1cmUuY2FjaGUuZ2VvWFksIGRpZmYpO1xuXG4gICAgICB9IGVsc2UgaWYgKCBmZWF0dXJlLmdlb2pzb24uZ2VvbWV0cnkudHlwZSA9PSAnUG9seWdvbicgKSB7XG4gICAgICAgIHRoaXMudXRpbHMubW92ZUxpbmUoZmVhdHVyZS5jYWNoZS5nZW9YWSwgZGlmZik7XG4gICAgICB9IGVsc2UgaWYgKCBmZWF0dXJlLmdlb2pzb24uZ2VvbWV0cnkudHlwZSA9PSAnTXVsdGlQb2x5Z29uJyApIHtcbiAgICAgICAgZm9yKCB2YXIgaSA9IDA7IGkgPCBmZWF0dXJlLmNhY2hlLmdlb1hZLmxlbmd0aDsgaSsrICkge1xuICAgICAgICAgIHRoaXMudXRpbHMubW92ZUxpbmUoZmVhdHVyZS5jYWNoZS5nZW9YWVtpXSwgZGlmZik7XG4gICAgICAgIH1cbiAgICAgIH1cbiAgICB9XG5cbiAgICAvLyBpZ25vcmUgYW55dGhpbmcgbm90IGluIGJvdW5kc1xuICAgIGlmKCBmZWF0dXJlLmdlb2pzb24uZ2VvbWV0cnkudHlwZSA9PSAnUG9pbnQnICkge1xuICAgICAgaWYoICFib3VuZHMuY29udGFpbnMoZmVhdHVyZS5sYXRsbmcpICkge1xuICAgICAgICByZXR1cm47XG4gICAgICB9XG4gICAgfSBlbHNlIGlmKCBmZWF0dXJlLmdlb2pzb24uZ2VvbWV0cnkudHlwZSA9PSAnTXVsdGlQb2x5Z29uJyApIHtcblxuICAgICAgLy8ganVzdCBtYWtlIHN1cmUgYXQgbGVhc3Qgb25lIHBvbHlnb24gaXMgd2l0aGluIHJhbmdlXG4gICAgICB2YXIgZm91bmQgPSBmYWxzZTtcbiAgICAgIGZvciggdmFyIGkgPSAwOyBpIDwgZmVhdHVyZS5ib3VuZHMubGVuZ3RoOyBpKysgKSB7XG4gICAgICAgIGlmKCBib3VuZHMuY29udGFpbnMoZmVhdHVyZS5ib3VuZHNbaV0pIHx8IGJvdW5kcy5pbnRlcnNlY3RzKGZlYXR1cmUuYm91bmRzW2ldKSApIHtcbiAgICAgICAgICBmb3VuZCA9IHRydWU7XG4gICAgICAgICAgYnJlYWs7XG4gICAgICAgIH1cbiAgICAgIH1cbiAgICAgIGlmKCAhZm91bmQgKSByZXR1cm47XG5cbiAgICB9IGVsc2Uge1xuICAgICAgaWYoICFib3VuZHMuY29udGFpbnMoZmVhdHVyZS5ib3VuZHMpICYmICFib3VuZHMuaW50ZXJzZWN0cyhmZWF0dXJlLmJvdW5kcykgKSB7XG4gICAgICAgIHJldHVybjtcbiAgICAgIH1cbiAgICB9XG5cbiAgICAvLyBjYWxsIGZlYXR1cmUgcmVuZGVyIGZ1bmN0aW9uIGluIGZlYXR1cmUgc2NvcGU7IGZlYXR1cmUgaXMgcGFzc2VkIGFzIHdlbGxcbiAgICBmZWF0dXJlLnJlbmRlci5jYWxsKGZlYXR1cmUsIHRoaXMuX2N0eCwgZmVhdHVyZS5jYWNoZS5nZW9YWSwgdGhpcy5fbWFwLCBmZWF0dXJlKTtcbiAgfSxcblxuICBfY2FsY0dlb1hZIDogZnVuY3Rpb24oZmVhdHVyZSwgem9vbSkge1xuICAgIC8vIG1ha2Ugc3VyZSB3ZSBoYXZlIGEgY2FjaGUgbmFtZXNwYWNlIGFuZCBzZXQgdGhlIHpvb20gbGV2ZWxcbiAgICBpZiggIWZlYXR1cmUuY2FjaGUgKSBmZWF0dXJlLmNhY2hlID0ge307XG4gICAgZmVhdHVyZS5jYWNoZS56b29tID0gem9vbTtcblxuICAgIGlmKCBmZWF0dXJlLmdlb2pzb24uZ2VvbWV0cnkudHlwZSA9PSAnUG9pbnQnICkge1xuXG4gICAgICBmZWF0dXJlLmNhY2hlLmdlb1hZID0gdGhpcy5fbWFwLmxhdExuZ1RvQ29udGFpbmVyUG9pbnQoW1xuICAgICAgICAgIGZlYXR1cmUuZ2VvanNvbi5nZW9tZXRyeS5jb29yZGluYXRlc1sxXSxcbiAgICAgICAgICBmZWF0dXJlLmdlb2pzb24uZ2VvbWV0cnkuY29vcmRpbmF0ZXNbMF1cbiAgICAgIF0pO1xuXG4gICAgICBpZiggZmVhdHVyZS5zaXplICkge1xuICAgICAgICBmZWF0dXJlLmNhY2hlLmdlb1hZWzBdID0gZmVhdHVyZS5jYWNoZS5nZW9YWVswXSAtIGZlYXR1cmUuc2l6ZSAvIDI7XG4gICAgICAgIGZlYXR1cmUuY2FjaGUuZ2VvWFlbMV0gPSBmZWF0dXJlLmNhY2hlLmdlb1hZWzFdIC0gZmVhdHVyZS5zaXplIC8gMjtcbiAgICAgIH1cblxuICAgIH0gZWxzZSBpZiggZmVhdHVyZS5nZW9qc29uLmdlb21ldHJ5LnR5cGUgPT0gJ0xpbmVTdHJpbmcnICkge1xuICAgICAgZmVhdHVyZS5jYWNoZS5nZW9YWSA9IHRoaXMudXRpbHMucHJvamVjdExpbmUoZmVhdHVyZS5nZW9qc29uLmdlb21ldHJ5LmNvb3JkaW5hdGVzLCB0aGlzLl9tYXApO1xuXG4gICAgfSBlbHNlIGlmICggZmVhdHVyZS5nZW9qc29uLmdlb21ldHJ5LnR5cGUgPT0gJ1BvbHlnb24nICkge1xuICAgICAgZmVhdHVyZS5jYWNoZS5nZW9YWSA9IHRoaXMudXRpbHMucHJvamVjdExpbmUoZmVhdHVyZS5nZW9qc29uLmdlb21ldHJ5LmNvb3JkaW5hdGVzWzBdLCB0aGlzLl9tYXApO1xuICAgIH0gZWxzZSBpZiAoIGZlYXR1cmUuZ2VvanNvbi5nZW9tZXRyeS50eXBlID09ICdNdWx0aVBvbHlnb24nICkge1xuICAgICAgZmVhdHVyZS5jYWNoZS5nZW9YWSA9IFtdO1xuICAgICAgZm9yKCB2YXIgaSA9IDA7IGkgPCBmZWF0dXJlLmdlb2pzb24uZ2VvbWV0cnkuY29vcmRpbmF0ZXMubGVuZ3RoOyBpKysgKSB7XG4gICAgICAgIGZlYXR1cmUuY2FjaGUuZ2VvWFkucHVzaCh0aGlzLnV0aWxzLnByb2plY3RMaW5lKGZlYXR1cmUuZ2VvanNvbi5nZW9tZXRyeS5jb29yZGluYXRlc1tpXVswXSwgdGhpcy5fbWFwKSk7XG4gICAgICB9XG4gICAgfVxuXG4gIH0sXG5cbiAgYWRkRmVhdHVyZXMgOiBmdW5jdGlvbihmZWF0dXJlcykge1xuICAgIGZvciggdmFyIGkgPSAwOyBpIDwgdGhpcy5mZWF0dXJlcy5sZW5ndGg7IGkrKyApIHtcbiAgICAgIHRoaXMuYWRkRmVhdHVyZSh0aGlzLmZlYXR1cmVzW2ldKTtcbiAgICB9XG4gIH0sXG5cbiAgYWRkRmVhdHVyZSA6IGZ1bmN0aW9uKGZlYXR1cmUsIGJvdHRvbSkge1xuICAgIGlmKCAhZmVhdHVyZS5nZW9qc29uICkgcmV0dXJuO1xuICAgIGlmKCAhZmVhdHVyZS5nZW9qc29uLmdlb21ldHJ5ICkgcmV0dXJuO1xuXG4gICAgaWYoIHR5cGVvZiBmZWF0dXJlLnZpc2libGUgPT09ICd1bmRlZmluZWQnICkgZmVhdHVyZS52aXNpYmxlID0gdHJ1ZTtcbiAgICBmZWF0dXJlLmNhY2hlID0gbnVsbDtcblxuICAgIGlmKCBmZWF0dXJlLmdlb2pzb24uZ2VvbWV0cnkudHlwZSA9PSAnTGluZVN0cmluZycgKSB7XG4gICAgICBmZWF0dXJlLmJvdW5kcyA9IHRoaXMudXRpbHMuY2FsY0JvdW5kcyhmZWF0dXJlLmdlb2pzb24uZ2VvbWV0cnkuY29vcmRpbmF0ZXMpO1xuXG4gICAgfSBlbHNlIGlmICggZmVhdHVyZS5nZW9qc29uLmdlb21ldHJ5LnR5cGUgPT0gJ1BvbHlnb24nICkge1xuICAgICAgLy8gVE9ETzogd2Ugb25seSBzdXBwb3J0IG91dGVyIHJpbmdzIG91dCB0aGUgbW9tZW50LCBubyBpbm5lciByaW5ncy4gIFRodXMgY29vcmRpbmF0ZXNbMF1cbiAgICAgIGZlYXR1cmUuYm91bmRzID0gdGhpcy51dGlscy5jYWxjQm91bmRzKGZlYXR1cmUuZ2VvanNvbi5nZW9tZXRyeS5jb29yZGluYXRlc1swXSk7XG5cbiAgICB9IGVsc2UgaWYgKCBmZWF0dXJlLmdlb2pzb24uZ2VvbWV0cnkudHlwZSA9PSAnUG9pbnQnICkge1xuICAgICAgZmVhdHVyZS5sYXRsbmcgPSBMLmxhdExuZyhmZWF0dXJlLmdlb2pzb24uZ2VvbWV0cnkuY29vcmRpbmF0ZXNbMV0sIGZlYXR1cmUuZ2VvanNvbi5nZW9tZXRyeS5jb29yZGluYXRlc1swXSk7XG4gICAgfSBlbHNlIGlmICggZmVhdHVyZS5nZW9qc29uLmdlb21ldHJ5LnR5cGUgPT0gJ011bHRpUG9seWdvbicgKSB7XG4gICAgICBmZWF0dXJlLmJvdW5kcyA9IFtdO1xuICAgICAgZm9yKCB2YXIgaSA9IDA7IGkgPCBmZWF0dXJlLmdlb2pzb24uZ2VvbWV0cnkuY29vcmRpbmF0ZXMubGVuZ3RoOyBpKysgICkge1xuICAgICAgICBmZWF0dXJlLmJvdW5kcy5wdXNoKHRoaXMudXRpbHMuY2FsY0JvdW5kcyhmZWF0dXJlLmdlb2pzb24uZ2VvbWV0cnkuY29vcmRpbmF0ZXNbaV1bMF0pKTtcbiAgICAgIH1cbiAgICB9IGVsc2Uge1xuICAgICAgY29uc29sZS5sb2coJ0dlb0pTT04gZmVhdHVyZSB0eXBlIFwiJytmZWF0dXJlLmdlb2pzb24uZ2VvbWV0cnkudHlwZSsnXCIgbm90IHN1cHBvcnRlZC4nKTtcbiAgICAgIGNvbnNvbGUubG9nKGZlYXR1cmUuZ2VvanNvbik7XG4gICAgICByZXR1cm47XG4gICAgfVxuXG4gICAgaWYoIGJvdHRvbSApIHsgLy8gYm90dG9tIG9yIGluZGV4XG4gICAgICBpZiggdHlwZW9mIGJvdHRvbSA9PT0gJ251bWJlcicpIHRoaXMuZmVhdHVyZXMuc3BsaWNlKGJvdHRvbSwgMCwgZmVhdHVyZSk7XG4gICAgICBlbHNlIHRoaXMuZmVhdHVyZXMudW5zaGlmdChmZWF0dXJlKTtcbiAgICB9IGVsc2Uge1xuICAgICAgdGhpcy5mZWF0dXJlcy5wdXNoKGZlYXR1cmUpO1xuICAgIH1cbiAgfSxcblxuICBhZGRGZWF0dXJlQm90dG9tIDogZnVuY3Rpb24oZmVhdHVyZSkge1xuICAgIHRoaXMuYWRkRmVhdHVyZShmZWF0dXJlLCB0cnVlKTtcbiAgfSxcblxuICAvLyByZXR1cm5zIHRydWUgaWYgcmUtcmVuZGVyIHJlcXVpcmVkLiAgaWUgdGhlIGZlYXR1cmUgd2FzIHZpc2libGU7XG4gIHJlbW92ZUZlYXR1cmUgOiBmdW5jdGlvbihmZWF0dXJlKSB7XG4gICAgdmFyIGluZGV4ID0gdGhpcy5mZWF0dXJlcy5pbmRleE9mKGZlYXR1cmUpO1xuICAgIGlmKCBpbmRleCA9PSAtMSApIHJldHVybjtcblxuICAgIHRoaXMuc3BsaWNlKGluZGV4LCAxKTtcblxuICAgIGlmKCB0aGlzLmZlYXR1cmUudmlzaWJsZSApIHJldHVybiB0cnVlO1xuICAgIHJldHVybiBmYWxzZTtcbiAgfSxcblxuICAvLyBnZXQgbGF5ZXIgZmVhdHVyZSB2aWEgZ2VvanNvbiBvYmplY3RcbiAgZ2V0RmVhdHVyZUZvckdlb2pzb24gOiBmdW5jdGlvbihnZW9qc29uKSB7XG4gICAgZm9yKCB2YXIgaSA9IDA7IGkgPCB0aGlzLmZlYXR1cmVzLmxlbmd0aDsgaSsrICkge1xuICAgICAgaWYoIHRoaXMuZmVhdHVyZXNbaV0uZ2VvanNvbiA9PSBnZW9qc29uICkgcmV0dXJuIHRoaXMuZmVhdHVyZXNbaV07XG4gICAgfVxuXG4gICAgcmV0dXJuIG51bGw7XG4gIH0sXG5cbiAgcmVuZGVyOiBmdW5jdGlvbihlKSB7XG4gICAgdmFyIHQsIGRpZmZcbiAgICBpZiggdGhpcy5kZWJ1ZyApIHQgPSBuZXcgRGF0ZSgpLmdldFRpbWUoKTtcblxuICAgIHZhciBkaWZmID0gbnVsbDtcbiAgICBpZiggZSAmJiBlLnR5cGUgPT0gJ21vdmUnICkge1xuICAgICAgdmFyIGNlbnRlciA9IHRoaXMuX21hcC5nZXRDZW50ZXIoKTtcblxuICAgICAgdmFyIHB0ID0gdGhpcy5fbWFwLmxhdExuZ1RvQ29udGFpbmVyUG9pbnQoY2VudGVyKTtcbiAgICAgIGlmKCB0aGlzLmxhc3RDZW50ZXJMTCApIHtcbiAgICAgICAgdmFyIGxhc3RYeSA9IHRoaXMuX21hcC5sYXRMbmdUb0NvbnRhaW5lclBvaW50KHRoaXMubGFzdENlbnRlckxMKTtcbiAgICAgICAgZGlmZiA9IHtcbiAgICAgICAgICB4IDogbGFzdFh5LnggLSBwdC54LFxuICAgICAgICAgIHkgOiBsYXN0WHkueSAtIHB0LnlcbiAgICAgICAgfVxuICAgICAgfVxuXG4gICAgICB0aGlzLmxhc3RDZW50ZXJMTCA9IGNlbnRlcjtcbiAgICB9XG5cbiAgICB2YXIgdG9wTGVmdCA9IHRoaXMuX21hcC5jb250YWluZXJQb2ludFRvTGF5ZXJQb2ludChbMCwgMF0pO1xuICAgIEwuRG9tVXRpbC5zZXRQb3NpdGlvbih0aGlzLl9jYW52YXMsIHRvcExlZnQpO1xuXG4gICAgdmFyIGNhbnZhcyA9IHRoaXMuZ2V0Q2FudmFzKCk7XG4gICAgdmFyIGN0eCA9IGNhbnZhcy5nZXRDb250ZXh0KCcyZCcpO1xuXG4gICAgLy8gY2xlYXIgY2FudmFzXG4gICAgY3R4LmNsZWFyUmVjdCgwLCAwLCBjYW52YXMud2lkdGgsIGNhbnZhcy5oZWlnaHQpO1xuXG4gICAgaWYoICF0aGlzLnpvb21pbmcgKSB0aGlzLnJlZHJhdyhkaWZmKTtcblxuICAgIGlmKCB0aGlzLmRlYnVnICkge1xuICAgICAgZGlmZiA9IG5ldyBEYXRlKCkuZ2V0VGltZSgpIC0gdDtcblxuICAgICAgdmFyIGMgPSAwO1xuICAgICAgZm9yKCB2YXIgaSA9IDA7IGkgPCB0aGlzLmZlYXR1cmVzLmxlbmd0aDsgaSsrICkge1xuICAgICAgICBpZiggIXRoaXMuZmVhdHVyZXNbaV0uY2FjaGUuZ2VvWFkgKSBjb250aW51ZTtcbiAgICAgICAgaWYoIEFycmF5LmlzQXJyYXkodGhpcy5mZWF0dXJlc1tpXS5jYWNoZS5nZW9YWSkgKSBjICs9IHRoaXMuZmVhdHVyZXNbaV0uY2FjaGUuZ2VvWFkubGVuZ3RoO1xuICAgICAgfVxuXG4gICAgICBjb25zb2xlLmxvZygnUmVuZGVyZWQgJytjKycgcHRzIGluICcrZGlmZisnbXMnKTtcbiAgICB9XG4gIH0sXG5cbiAgLypcbiAgICByZXR1cm4gbGlzdCBvZiBhbGwgaW50ZXJzZWN0aW5nIGdlb21ldHJ5IHJlZ3JhZGxlc3MgaXMgY3VycmVudGx5IHZpc2libGVcblxuICAgIHB4UmFkaXVzIC0gaXMgZm9yIGxpbmVzIGFuZCBwb2ludHMgb25seS4gIEJhc2ljYWxseSBob3cgZmFyIG9mZiB0aGUgbGluZSBvclxuICAgIG9yIHBvaW50IGEgbGF0bG5nIGNhbiBiZSBhbmQgc3RpbGwgYmUgY29uc2lkZXJlZCBpbnRlcnNlY3RpbmcuICBUaGlzIGlzXG4gICAgZ2l2ZW4gaW4gcHggYXMgaXQgaXMgY29tcGVuc2F0aW5nIGZvciB1c2VyIGludGVudCB3aXRoIG1vdXNlIGNsaWNrIG9yIHRvdWNoLlxuICAgIFRoZSBwb2ludCBtdXN0IGxheSBpbnNpZGUgdG8gcG9seWdvbiBmb3IgYSBtYXRjaC5cbiAgKi9cbiAgZ2V0QWxsSW50ZXJzZWN0aW5nR2VvbWV0cnkgOiBmdW5jdGlvbihsYXRsbmcsIHB4UmFkaXVzKSB7XG4gICAgdmFyIG1wcCA9IHRoaXMudXRpbHMubWV0ZXJzUGVyUHgobGF0bG5nLCB0aGlzLl9tYXApO1xuICAgIHZhciByID0gbXBwICogKHB4UmFkaXVzIHx8IDUpOyAvLyA1IHB4IHJhZGl1cyBidWZmZXI7XG5cbiAgICB2YXIgY2VudGVyID0ge1xuICAgICAgdHlwZSA6ICdQb2ludCcsXG4gICAgICBjb29yZGluYXRlcyA6IFtsYXRsbmcubG5nLCBsYXRsbmcubGF0XVxuICAgIH07XG4gICAgdmFyIHpvb20gPSB0aGlzLl9tYXAuZ2V0Wm9vbSgpO1xuICAgIHZhciBjb250YWluZXJQb2ludCA9IHRoaXMuX21hcC5sYXRMbmdUb0NvbnRhaW5lclBvaW50KGxhdGxuZyk7XG5cbiAgICB2YXIgZjtcbiAgICB2YXIgaW50ZXJzZWN0cyA9IFtdO1xuXG4gICAgZm9yKCB2YXIgaSA9IDA7IGkgPCB0aGlzLmZlYXR1cmVzLmxlbmd0aDsgaSsrICkge1xuICAgICAgZiA9IHRoaXMuZmVhdHVyZXNbaV07XG5cbiAgICAgIGlmKCAhZi5nZW9qc29uLmdlb21ldHJ5ICkgY29udGludWU7XG5cbiAgICAgIC8vIGNoZWNrIHRoZSBib3VuZGluZyBib3ggZm9yIGludGVyc2VjdGlvbiBmaXJzdFxuICAgICAgaWYoICF0aGlzLl9pc0luQm91bmRzKGZlYXR1cmUsIGxhdGxuZykgKSBjb250aW51ZTtcblxuICAgICAgLy8gc2VlIGlmIHdlIG5lZWQgdG8gcmVjYWxjIHRoZSB4LHkgc2NyZWVuIGNvb3JkaW5hdGUgY2FjaGVcbiAgICAgIGlmKCAhZi5jYWNoZSApIHRoaXMuX2NhbGNHZW9YWShmLCB6b29tKTtcbiAgICAgIGVsc2UgaWYoICFmLmNhY2hlLmdlb1hZICkgdGhpcy5fY2FsY0dlb1hZKGYsIHpvb20pO1xuXG4gICAgICBpZiggdGhpcy51dGlscy5nZW9tZXRyeVdpdGhpblJhZGl1cyhmLmdlb2pzb24uZ2VvbWV0cnksIGYuY2FjaGUuZ2VvWFksIGNlbnRlciwgY29udGFpbmVyUG9pbnQsIHIpICkge1xuICAgICAgICBpbnRlcnNlY3RzLnB1c2goZik7XG4gICAgICB9XG4gICAgfVxuXG4gICAgcmV0dXJuIGludGVyc2VjdHM7XG4gIH0sXG5cbiAgLy8gcmV0dXJucyB0cnVlIGlmIGluIGJvdW5kcyBvciB1bmtub3duXG4gIF9pc0luQm91bmRzIDogZnVuY3Rpb24oZmVhdHVyZSwgbGF0bG5nKSB7XG4gICAgaWYoIGZlYXR1cmUuYm91bmRzICkge1xuICAgICAgaWYoIEFycmF5LmlzQXJyYXkoZmVhdHVyZS5ib3VuZHMpICkge1xuXG4gICAgICAgIGZvciggdmFyIGkgPSAwOyBpIDwgZmVhdHVyZS5ib3VuZHMubGVuZ3RoOyBpKysgKSB7XG4gICAgICAgICAgaWYoIGZlYXR1cmUuYm91bmRzW2ldLmNvbnRhaW5zKGxhdGxuZykgKSByZXR1cm4gdHJ1ZTtcbiAgICAgICAgfVxuXG4gICAgICB9IGVsc2UgaWYgKCBmZWF0dXJlLmJvdW5kcy5jb250YWlucyhsYXRsbmcpICkge1xuICAgICAgICByZXR1cm4gdHJ1ZTtcbiAgICAgIH1cblxuICAgICAgcmV0dXJuIGZhbHNlO1xuICAgIH1cbiAgICByZXR1cm4gdHJ1ZTtcbiAgfSxcblxuICAvLyBnZXQgdGhlIG1ldGVycyBwZXIgcHggYW5kIGEgY2VydGFpbiBwb2ludDtcbiAgZ2V0TWV0ZXJzUGVyUHggOiBmdW5jdGlvbihsYXRsbmcpIHtcbiAgICByZXR1cm4gdGhpcy51dGlscy5tZXRlcnNQZXJQeChsYXRsbmcsIHRoaXMuX21hcCk7XG4gIH0sXG5cbiAgX2ludGVyc2VjdHMgOiBmdW5jdGlvbihlKSB7XG4gICAgdmFyIHQgPSBuZXcgRGF0ZSgpLmdldFRpbWUoKTtcbiAgICB2YXIgbXBwID0gdGhpcy5nZXRNZXRlcnNQZXJQeChlLmxhdGxuZyk7XG4gICAgdmFyIHIgPSBtcHAgKiA1OyAvLyA1IHB4IHJhZGl1cyBidWZmZXI7XG5cbiAgICB2YXIgY2VudGVyID0ge1xuICAgICAgdHlwZSA6ICdQb2ludCcsXG4gICAgICBjb29yZGluYXRlcyA6IFtlLmxhdGxuZy5sbmcsIGUubGF0bG5nLmxhdF1cbiAgICB9O1xuXG4gICAgdmFyIGY7XG4gICAgdmFyIGludGVyc2VjdHMgPSBbXTtcblxuICAgIGZvciggdmFyIGkgPSAwOyBpIDwgdGhpcy5mZWF0dXJlcy5sZW5ndGg7IGkrKyApIHtcbiAgICAgIGYgPSB0aGlzLmZlYXR1cmVzW2ldO1xuXG4gICAgICBpZiggIWYudmlzaWJsZSApIGNvbnRpbnVlO1xuICAgICAgaWYoICFmLmdlb2pzb24uZ2VvbWV0cnkgKSBjb250aW51ZTtcbiAgICAgIGlmKCAhZi5jYWNoZSApIGNvbnRpbnVlO1xuICAgICAgaWYoICFmLmNhY2hlLmdlb1hZICkgY29udGludWU7XG4gICAgICBpZiggIXRoaXMuX2lzSW5Cb3VuZHMoZiwgZS5sYXRsbmcpICkgY29udGludWU7XG5cbiAgICAgIGlmKCB0aGlzLnV0aWxzLmdlb21ldHJ5V2l0aGluUmFkaXVzKGYuZ2VvanNvbi5nZW9tZXRyeSwgZi5jYWNoZS5nZW9YWSwgY2VudGVyLCBlLmNvbnRhaW5lclBvaW50LCBmLnNpemUgPyAoZi5zaXplICogbXBwKSA6IHIpICkge1xuICAgICAgICBpbnRlcnNlY3RzLnB1c2goZi5nZW9qc29uKTtcbiAgICAgIH1cblxuICAgIH1cblxuICAgIGlmKCBlLnR5cGUgPT0gJ2NsaWNrJyAmJiB0aGlzLm9uQ2xpY2sgKSB7XG4gICAgICB0aGlzLm9uQ2xpY2soaW50ZXJzZWN0cyk7XG4gICAgICByZXR1cm47XG4gICAgfVxuXG4gICAgdmFyIG1vdXNlb3ZlciA9IFtdLCBtb3VzZW91dCA9IFtdLCBtb3VzZW1vdmUgPSBbXTtcblxuICAgIHZhciBjaGFuZ2VkID0gZmFsc2U7XG4gICAgZm9yKCB2YXIgaSA9IDA7IGkgPCBpbnRlcnNlY3RzLmxlbmd0aDsgaSsrICkge1xuICAgICAgaWYoIHRoaXMuaW50ZXJzZWN0TGlzdC5pbmRleE9mKGludGVyc2VjdHNbaV0pID4gLTEgKSB7XG4gICAgICAgIG1vdXNlbW92ZS5wdXNoKGludGVyc2VjdHNbaV0pO1xuICAgICAgfSBlbHNlIHtcbiAgICAgICAgY2hhbmdlZCA9IHRydWU7XG4gICAgICAgIG1vdXNlb3Zlci5wdXNoKGludGVyc2VjdHNbaV0pO1xuICAgICAgfVxuICAgIH1cblxuICAgIGZvciggdmFyIGkgPSAwOyBpIDwgdGhpcy5pbnRlcnNlY3RMaXN0Lmxlbmd0aDsgaSsrICkge1xuICAgICAgaWYoIGludGVyc2VjdHMuaW5kZXhPZih0aGlzLmludGVyc2VjdExpc3RbaV0pID09IC0xICkge1xuICAgICAgICBjaGFuZ2VkID0gdHJ1ZTtcbiAgICAgICAgbW91c2VvdXQucHVzaCh0aGlzLmludGVyc2VjdExpc3RbaV0pO1xuICAgICAgfVxuICAgIH1cblxuICAgIHRoaXMuaW50ZXJzZWN0TGlzdCA9IGludGVyc2VjdHM7XG5cbiAgICBpZiggdGhpcy5vbk1vdXNlT3ZlciAmJiBtb3VzZW92ZXIubGVuZ3RoID4gMCApIHRoaXMub25Nb3VzZU92ZXIuY2FsbCh0aGlzLCBtb3VzZW92ZXIsIGUpO1xuICAgIGlmKCB0aGlzLm9uTW91c2VNb3ZlICYmIG1vdXNlbW92ZS5sZW5ndGggPiAwICkgdGhpcy5vbk1vdXNlTW92ZS5jYWxsKHRoaXMsIG1vdXNlbW92ZSwgZSk7XG4gICAgaWYoIHRoaXMub25Nb3VzZU91dCAmJiBtb3VzZW91dC5sZW5ndGggPiAwICkgdGhpcy5vbk1vdXNlT3V0LmNhbGwodGhpcywgbW91c2VvdXQsIGUpO1xuXG4gICAgaWYoIHRoaXMuZGVidWcgKSBjb25zb2xlLmxvZygnaW50ZXJzZWN0cyB0aW1lOiAnKyhuZXcgRGF0ZSgpLmdldFRpbWUoKSAtIHQpKydtcycpO1xuXG4gICAgaWYoIGNoYW5nZWQgKSB0aGlzLnJlbmRlcigpO1xuICB9XG59KTtcbiIsIm1vZHVsZS5leHBvcnRzID0ge1xuICBtb3ZlTGluZSA6IGZ1bmN0aW9uKGNvb3JkcywgZGlmZikge1xuICAgIHZhciBpOyBsZW4gPSBjb29yZHMubGVuZ3RoO1xuICAgIGZvciggaSA9IDA7IGkgPCBsZW47IGkrKyApIHtcbiAgICAgIGNvb3Jkc1tpXS54ICs9IGRpZmYueDtcbiAgICAgIGNvb3Jkc1tpXS55ICs9IGRpZmYueTtcbiAgICB9XG4gIH0sXG5cbiAgcHJvamVjdExpbmUgOiBmdW5jdGlvbihjb29yZHMsIG1hcCkge1xuICAgIHZhciB4eUxpbmUgPSBbXTtcblxuICAgIGZvciggdmFyIGkgPSAwOyBpIDwgY29vcmRzLmxlbmd0aDsgaSsrICkge1xuICAgICAgeHlMaW5lLnB1c2gobWFwLmxhdExuZ1RvQ29udGFpbmVyUG9pbnQoW1xuICAgICAgICAgIGNvb3Jkc1tpXVsxXSwgY29vcmRzW2ldWzBdXG4gICAgICBdKSk7XG4gICAgfVxuXG4gICAgcmV0dXJuIHh5TGluZTtcbiAgfSxcblxuICBjYWxjQm91bmRzIDogZnVuY3Rpb24oY29vcmRzKSB7XG4gICAgdmFyIHhtaW4gPSBjb29yZHNbMF1bMV07XG4gICAgdmFyIHhtYXggPSBjb29yZHNbMF1bMV07XG4gICAgdmFyIHltaW4gPSBjb29yZHNbMF1bMF07XG4gICAgdmFyIHltYXggPSBjb29yZHNbMF1bMF07XG5cbiAgICBmb3IoIHZhciBpID0gMTsgaSA8IGNvb3Jkcy5sZW5ndGg7IGkrKyApIHtcbiAgICAgIGlmKCB4bWluID4gY29vcmRzW2ldWzFdICkgeG1pbiA9IGNvb3Jkc1tpXVsxXTtcbiAgICAgIGlmKCB4bWF4IDwgY29vcmRzW2ldWzFdICkgeG1heCA9IGNvb3Jkc1tpXVsxXTtcblxuICAgICAgaWYoIHltaW4gPiBjb29yZHNbaV1bMF0gKSB5bWluID0gY29vcmRzW2ldWzBdO1xuICAgICAgaWYoIHltYXggPCBjb29yZHNbaV1bMF0gKSB5bWF4ID0gY29vcmRzW2ldWzBdO1xuICAgIH1cblxuICAgIHZhciBzb3V0aFdlc3QgPSBMLmxhdExuZyh4bWluLS4wMSwgeW1pbi0uMDEpO1xuICAgIHZhciBub3J0aEVhc3QgPSBMLmxhdExuZyh4bWF4Ky4wMSwgeW1heCsuMDEpO1xuXG4gICAgcmV0dXJuIEwubGF0TG5nQm91bmRzKHNvdXRoV2VzdCwgbm9ydGhFYXN0KTtcbiAgfSxcblxuICBnZW9tZXRyeVdpdGhpblJhZGl1cyA6IGZ1bmN0aW9uKGdlb21ldHJ5LCB4eVBvaW50cywgY2VudGVyLCB4eVBvaW50LCByYWRpdXMpIHtcbiAgICBpZiAoZ2VvbWV0cnkudHlwZSA9PSAnUG9pbnQnKSB7XG4gICAgICByZXR1cm4gdGhpcy5wb2ludERpc3RhbmNlKGdlb21ldHJ5LCBjZW50ZXIpIDw9IHJhZGl1cztcbiAgICB9IGVsc2UgaWYgKGdlb21ldHJ5LnR5cGUgPT0gJ0xpbmVTdHJpbmcnICkge1xuXG4gICAgICBmb3IoIHZhciBpID0gMTsgaSA8IHh5UG9pbnRzLmxlbmd0aDsgaSsrICkge1xuICAgICAgICBpZiggdGhpcy5saW5lSW50ZXJzZWN0c0NpcmNsZSh4eVBvaW50c1tpLTFdLCB4eVBvaW50c1tpXSwgeHlQb2ludCwgMykgKSB7XG4gICAgICAgICAgcmV0dXJuIHRydWU7XG4gICAgICAgIH1cbiAgICAgIH1cblxuICAgICAgcmV0dXJuIGZhbHNlO1xuICAgIH0gZWxzZSBpZiAoZ2VvbWV0cnkudHlwZSA9PSAnUG9seWdvbicgfHwgZ2VvbWV0cnkudHlwZSA9PSAnTXVsdGlQb2x5Z29uJykge1xuICAgICAgcmV0dXJuIHRoaXMucG9pbnRJblBvbHlnb24oY2VudGVyLCBnZW9tZXRyeSk7XG4gICAgfVxuICB9LFxuXG4gIC8vIGh0dHA6Ly9tYXRoLnN0YWNrZXhjaGFuZ2UuY29tL3F1ZXN0aW9ucy8yNzU1MjkvY2hlY2staWYtbGluZS1pbnRlcnNlY3RzLXdpdGgtY2lyY2xlcy1wZXJpbWV0ZXJcbiAgLy8gaHR0cHM6Ly9lbi53aWtpcGVkaWEub3JnL3dpa2kvRGlzdGFuY2VfZnJvbV9hX3BvaW50X3RvX2FfbGluZVxuICAvLyBbbG5nIHgsIGxhdCwgeV1cbiAgbGluZUludGVyc2VjdHNDaXJjbGUgOiBmdW5jdGlvbihsaW5lUDEsIGxpbmVQMiwgcG9pbnQsIHJhZGl1cykge1xuICAgIHZhciBkaXN0YW5jZSA9XG4gICAgICBNYXRoLmFicyhcbiAgICAgICAgKChsaW5lUDIueSAtIGxpbmVQMS55KSpwb2ludC54KSAtICgobGluZVAyLnggLSBsaW5lUDEueCkqcG9pbnQueSkgKyAobGluZVAyLngqbGluZVAxLnkpIC0gKGxpbmVQMi55KmxpbmVQMS54KVxuICAgICAgKSAvXG4gICAgICBNYXRoLnNxcnQoXG4gICAgICAgIE1hdGgucG93KGxpbmVQMi55IC0gbGluZVAxLnksIDIpICsgTWF0aC5wb3cobGluZVAyLnggLSBsaW5lUDEueCwgMilcbiAgICAgICk7XG4gICAgcmV0dXJuIGRpc3RhbmNlIDw9IHJhZGl1cztcbiAgfSxcblxuICAvLyBodHRwOi8vd2lraS5vcGVuc3RyZWV0bWFwLm9yZy93aWtpL1pvb21fbGV2ZWxzXG4gIC8vIGh0dHA6Ly9zdGFja292ZXJmbG93LmNvbS9xdWVzdGlvbnMvMjc1NDUwOTgvbGVhZmxldC1jYWxjdWxhdGluZy1tZXRlcnMtcGVyLXBpeGVsLWF0LXpvb20tbGV2ZWxcbiAgbWV0ZXJzUGVyUHggOiBmdW5jdGlvbihsbCwgbWFwKSB7XG4gICAgdmFyIHBvaW50QyA9IG1hcC5sYXRMbmdUb0NvbnRhaW5lclBvaW50KGxsKTsgLy8gY29udmVydCB0byBjb250YWluZXJwb2ludCAocGl4ZWxzKVxuICAgIHZhciBwb2ludFggPSBbcG9pbnRDLnggKyAxLCBwb2ludEMueV07IC8vIGFkZCBvbmUgcGl4ZWwgdG8geFxuXG4gICAgLy8gY29udmVydCBjb250YWluZXJwb2ludHMgdG8gbGF0bG5nJ3NcbiAgICB2YXIgbGF0TG5nQyA9IG1hcC5jb250YWluZXJQb2ludFRvTGF0TG5nKHBvaW50Qyk7XG4gICAgdmFyIGxhdExuZ1ggPSBtYXAuY29udGFpbmVyUG9pbnRUb0xhdExuZyhwb2ludFgpO1xuXG4gICAgdmFyIGRpc3RhbmNlWCA9IGxhdExuZ0MuZGlzdGFuY2VUbyhsYXRMbmdYKTsgLy8gY2FsY3VsYXRlIGRpc3RhbmNlIGJldHdlZW4gYyBhbmQgeCAobGF0aXR1ZGUpXG4gICAgcmV0dXJuIGRpc3RhbmNlWDtcbiAgfSxcblxuICAvLyBmcm9tIGh0dHA6Ly93d3cubW92YWJsZS10eXBlLmNvLnVrL3NjcmlwdHMvbGF0bG9uZy5odG1sXG4gIHBvaW50RGlzdGFuY2UgOiBmdW5jdGlvbiAocHQxLCBwdDIpIHtcbiAgICB2YXIgbG9uMSA9IHB0MS5jb29yZGluYXRlc1swXSxcbiAgICAgIGxhdDEgPSBwdDEuY29vcmRpbmF0ZXNbMV0sXG4gICAgICBsb24yID0gcHQyLmNvb3JkaW5hdGVzWzBdLFxuICAgICAgbGF0MiA9IHB0Mi5jb29yZGluYXRlc1sxXSxcbiAgICAgIGRMYXQgPSB0aGlzLm51bWJlclRvUmFkaXVzKGxhdDIgLSBsYXQxKSxcbiAgICAgIGRMb24gPSB0aGlzLm51bWJlclRvUmFkaXVzKGxvbjIgLSBsb24xKSxcbiAgICAgIGEgPSBNYXRoLnBvdyhNYXRoLnNpbihkTGF0IC8gMiksIDIpICsgTWF0aC5jb3ModGhpcy5udW1iZXJUb1JhZGl1cyhsYXQxKSlcbiAgICAgICAgKiBNYXRoLmNvcyh0aGlzLm51bWJlclRvUmFkaXVzKGxhdDIpKSAqIE1hdGgucG93KE1hdGguc2luKGRMb24gLyAyKSwgMiksXG4gICAgICBjID0gMiAqIE1hdGguYXRhbjIoTWF0aC5zcXJ0KGEpLCBNYXRoLnNxcnQoMSAtIGEpKTtcbiAgICByZXR1cm4gKDYzNzEgKiBjKSAqIDEwMDA7IC8vIHJldHVybnMgbWV0ZXJzXG4gIH0sXG5cbiAgcG9pbnRJblBvbHlnb24gOiBmdW5jdGlvbiAocCwgcG9seSkge1xuICAgIHZhciBjb29yZHMgPSAocG9seS50eXBlID09IFwiUG9seWdvblwiKSA/IFsgcG9seS5jb29yZGluYXRlcyBdIDogcG9seS5jb29yZGluYXRlc1xuXG4gICAgdmFyIGluc2lkZUJveCA9IGZhbHNlXG4gICAgZm9yICh2YXIgaSA9IDA7IGkgPCBjb29yZHMubGVuZ3RoOyBpKyspIHtcbiAgICAgIGlmICh0aGlzLnBvaW50SW5Cb3VuZGluZ0JveChwLCB0aGlzLmJvdW5kaW5nQm94QXJvdW5kUG9seUNvb3Jkcyhjb29yZHNbaV0pKSkgaW5zaWRlQm94ID0gdHJ1ZVxuICAgIH1cbiAgICBpZiAoIWluc2lkZUJveCkgcmV0dXJuIGZhbHNlXG5cbiAgICB2YXIgaW5zaWRlUG9seSA9IGZhbHNlXG4gICAgZm9yICh2YXIgaSA9IDA7IGkgPCBjb29yZHMubGVuZ3RoOyBpKyspIHtcbiAgICAgIGlmICh0aGlzLnBucG9seShwLmNvb3JkaW5hdGVzWzFdLCBwLmNvb3JkaW5hdGVzWzBdLCBjb29yZHNbaV0pKSBpbnNpZGVQb2x5ID0gdHJ1ZVxuICAgIH1cblxuICAgIHJldHVybiBpbnNpZGVQb2x5XG4gIH0sXG5cbiAgcG9pbnRJbkJvdW5kaW5nQm94IDogZnVuY3Rpb24gKHBvaW50LCBib3VuZHMpIHtcbiAgICByZXR1cm4gIShwb2ludC5jb29yZGluYXRlc1sxXSA8IGJvdW5kc1swXVswXSB8fCBwb2ludC5jb29yZGluYXRlc1sxXSA+IGJvdW5kc1sxXVswXSB8fCBwb2ludC5jb29yZGluYXRlc1swXSA8IGJvdW5kc1swXVsxXSB8fCBwb2ludC5jb29yZGluYXRlc1swXSA+IGJvdW5kc1sxXVsxXSlcbiAgfSxcblxuICBib3VuZGluZ0JveEFyb3VuZFBvbHlDb29yZHMgOiBmdW5jdGlvbihjb29yZHMpIHtcbiAgICB2YXIgeEFsbCA9IFtdLCB5QWxsID0gW11cblxuICAgIGZvciAodmFyIGkgPSAwOyBpIDwgY29vcmRzWzBdLmxlbmd0aDsgaSsrKSB7XG4gICAgICB4QWxsLnB1c2goY29vcmRzWzBdW2ldWzFdKVxuICAgICAgeUFsbC5wdXNoKGNvb3Jkc1swXVtpXVswXSlcbiAgICB9XG5cbiAgICB4QWxsID0geEFsbC5zb3J0KGZ1bmN0aW9uIChhLGIpIHsgcmV0dXJuIGEgLSBiIH0pXG4gICAgeUFsbCA9IHlBbGwuc29ydChmdW5jdGlvbiAoYSxiKSB7IHJldHVybiBhIC0gYiB9KVxuXG4gICAgcmV0dXJuIFsgW3hBbGxbMF0sIHlBbGxbMF1dLCBbeEFsbFt4QWxsLmxlbmd0aCAtIDFdLCB5QWxsW3lBbGwubGVuZ3RoIC0gMV1dIF1cbiAgfSxcblxuICAvLyBQb2ludCBpbiBQb2x5Z29uXG4gIC8vIGh0dHA6Ly93d3cuZWNzZS5ycGkuZWR1L0hvbWVwYWdlcy93cmYvUmVzZWFyY2gvU2hvcnRfTm90ZXMvcG5wb2x5Lmh0bWwjTGlzdGluZyB0aGUgVmVydGljZXNcbiAgcG5wb2x5IDogZnVuY3Rpb24oeCx5LGNvb3Jkcykge1xuICAgIHZhciB2ZXJ0ID0gWyBbMCwwXSBdXG5cbiAgICBmb3IgKHZhciBpID0gMDsgaSA8IGNvb3Jkcy5sZW5ndGg7IGkrKykge1xuICAgICAgZm9yICh2YXIgaiA9IDA7IGogPCBjb29yZHNbaV0ubGVuZ3RoOyBqKyspIHtcbiAgICAgICAgdmVydC5wdXNoKGNvb3Jkc1tpXVtqXSlcbiAgICAgIH1cbiAgICAgIHZlcnQucHVzaChjb29yZHNbaV1bMF0pXG4gICAgICB2ZXJ0LnB1c2goWzAsMF0pXG4gICAgfVxuXG4gICAgdmFyIGluc2lkZSA9IGZhbHNlXG4gICAgZm9yICh2YXIgaSA9IDAsIGogPSB2ZXJ0Lmxlbmd0aCAtIDE7IGkgPCB2ZXJ0Lmxlbmd0aDsgaiA9IGkrKykge1xuICAgICAgaWYgKCgodmVydFtpXVswXSA+IHkpICE9ICh2ZXJ0W2pdWzBdID4geSkpICYmICh4IDwgKHZlcnRbal1bMV0gLSB2ZXJ0W2ldWzFdKSAqICh5IC0gdmVydFtpXVswXSkgLyAodmVydFtqXVswXSAtIHZlcnRbaV1bMF0pICsgdmVydFtpXVsxXSkpIGluc2lkZSA9ICFpbnNpZGVcbiAgICB9XG5cbiAgICByZXR1cm4gaW5zaWRlXG4gIH0sXG5cbiAgbnVtYmVyVG9SYWRpdXMgOiBmdW5jdGlvbiAobnVtYmVyKSB7XG4gICAgcmV0dXJuIG51bWJlciAqIE1hdGguUEkgLyAxODA7XG4gIH1cbn07XG4iXX0=
