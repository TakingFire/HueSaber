'use strict';

const { ipcRenderer } = require('electron');
const { setTimeout } = require('timers'); // dtls dependency
require('binary-data');                   // dtls dependency
const dtls = require('@nodertc/dtls');
const { Buffer } = require('buffer');
const path = require('path');
const fs = require('fs');


const Color = {
  rgbToHex: function(rgb) {
    return '#' + rgb.map(x => x.toString(16)).map(x => x.length == 1 ? '0' + x : x).join('');
  },

  hexToXY: function(hex) {
    const rgb = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
    let [r, g, b] = [parseInt(rgb[1], 16), parseInt(rgb[2], 16), parseInt(rgb[3], 16)];
    // Source: https://github.com/ArndBrugman/huepi/blob/gh-pages/huepi.js#L713
    if (r > 0.04045) { r = Math.pow((r + 0.055) / (1.055), 2.4) }
    else { r = r / 12.92 }
    if (g > 0.04045) { g = Math.pow((g + 0.055) / (1.055), 2.4) }
    else { g = g / 12.92 }
    if (b > 0.04045) { b = Math.pow((b + 0.055) / (1.055), 2.4) }
    else { b = b / 12.92 }
    const x = r * 0.664511 + g * 0.154324 + b * 0.162028;
    const y = r * 0.283881 + g * 0.668433 + b * 0.047685;
    const z = r * 0.000088 + g * 0.072310 + b * 0.986039;
    if ((x + y + z) === 0) { return [0, 0] }
    return [x / (x + y + z), y / (x + y + z)];
  },

  blend: function(c1, c2, factor) {
    factor = Math.min(Math.max(factor, 0), 1);
    return (c1 * (1 - factor)) + (c2 * factor);
  }
}


const Hue = {
  getBridges: async function() {
    const query = await $.get('https://discovery.meethue.com/');
    if (query[0] && 'error' in query[0]) { return [] }
    return query;
  },

  getBridgeConfig: async function(bridgeIp, apiKey = null) {
    const config = apiKey ?
      await $.get(`http://${bridgeIp}/api/${apiKey}/config`) :
      await $.get(`http://${bridgeIp}/api/config`);
    return config;
  },

  authorizeBridge: async function(bridgeIp) {
    return await new Promise(resolve => {
      const config = { "devicetype": "HueSaber#Desktop", "generateclientkey": true };

      const authloop = window.setInterval(async () => {
        const userid = await $.post(`http://${bridgeIp}/api`, JSON.stringify(config), 'json');

        if ('success' in userid[0]) {
          window.clearInterval(authloop);
          localStorage['apiKey'] = userid[0]['success']['username'];
          localStorage['clientKey'] = userid[0]['success']['clientkey'];
          resolve(true);
        }
      }, 3000);

      window.setTimeout(() => {
        window.clearInterval(authloop);
        resolve(false);
      }, 60000);
    });
  },

  testKey: async function(bridgeIp, apiKey) {
    const query = await $.get(`http://${bridgeIp}/api/${apiKey}`);
    return (query && query.lights) ? true : false;
  },

  getLights: async function(bridgeIp, apiKey) {
    if (Object.keys(App.Lights).length > 0) { return App.Lights }

    const lights = await $.get(`http://${bridgeIp}/api/${apiKey}/lights`);

    if (lights[0] && 'error' in lights[0]) { return {} }

    for (const [id, light] of Object.entries(lights)) {
      try {
        new Light(id, light);
      }
      catch (err) {
        console.warn(err);
        console.log('Failed to create light:');
        console.log(light);
      }
    }
    return App.Lights;
  },

  getGroups: async function(bridgeIp, apiKey) {
    const groups = await $.get(`http://${bridgeIp}/api/${apiKey}/groups `);
    return groups;
  }
}


const HueStream = {
  socket: null,
  streamLoop: null,

  createEntertainmentArea: async function() {
    const bridgeIp = localStorage['bridgeIp'];
    const apiKey = localStorage['apiKey'];

    const groups = await Hue.getGroups(bridgeIp, apiKey);

    for (const key of Object.keys(groups)) {
      const group = groups[key];

      if (group['name'] == 'HueSaber') {
        await $.ajax({
          type: 'PUT',
          url: `http://${bridgeIp}/api/${apiKey}/groups/${key}`,
          data: JSON.stringify({ lights: Object.keys(App.Lights) }),
          dataType: 'json',
          success: function(response) {
            console.log(response);
            localStorage['lightGroup'] = key;
          }
        });
        return;
      }
    }

    await $.ajax({
      type: 'POST',
      url: `http://${bridgeIp}/api/${apiKey}/groups`,
      data: JSON.stringify({
        name: 'HueSaber',
        type: 'Entertainment',
        class: 'TV',
        lights: Object.keys(App.Lights)
      }),
      dataType: 'json',
      success: function(response) {
        console.log(response);
        localStorage['lightGroup'] = response[0]['success']['id'];
      }
    });
  },

  setStreamingMode: async function(state) {
    const bridgeIp = localStorage['bridgeIp'];
    const apiKey = localStorage['apiKey'];

    await $.ajax({
      type: 'PUT',
      url: `http://${bridgeIp}/api/${apiKey}/groups/${localStorage['lightGroup']}`,
      data: JSON.stringify({ stream: { active: state } }),
      dataType: 'json',
      success: function(response) { console.log(response) }
    });
  },

  compilePacket: function() {
    const packet = [
      Buffer.from('HueStream', 'ascii'),
      Buffer.from([
        0x01, 0x00, // version
        0x00,       // sequence
        0x00, 0x00, // reserved
        0x01,       // use xy
        0x00        // reserved
      ])
    ]

    let lights = Object.values(App.Events['all'].getLights()).slice(0, 10); // max 10

    lights.forEach(function(light) {
      packet.push(HueStream.lightBuffer(light));
    })

    return Buffer.concat(packet, 16 + (9 * lights.length));
  },

  lightBuffer: function(light) {
    const array = new ArrayBuffer(9);
    const view = new DataView(array);
    const state = light.getState();

    view.setUint8(0, 0);
    view.setUint16(1, parseInt(light.id));
    view.setUint16(3, Math.floor(65535 * state.x));
    view.setUint16(5, Math.floor(65535 * state.y));
    view.setUint16(7, Math.floor(65535 * (state.bri / 254)));

    return Buffer.from(array);
  },

  startSocket: async function() {
    if (this.socket) { return }
    await this.createEntertainmentArea();
    await this.setStreamingMode(true);

    this.socket = dtls.connect({
      type: 'udp4',
      remotePort: 2100,
      remoteAddress: localStorage['bridgeIp'],
      pskIdentity: localStorage['apiKey'],
      pskSecret: Buffer.from(localStorage['clientKey'], 'hex'),
      cipherSuites: ['TLS_PSK_WITH_AES_128_GCM_SHA256']
    })

    this.socket.on('error', function(err) {
      HueStream.socket = null;
      console.error(err);
    });

    this.socket.once('connect', function() {
      console.log('Connected to Hue Stream');
      $('#start').html('Stop').prop('disabled', false);

      HueStream.streamLoop = setInterval(function() {
        let packet = HueStream.compilePacket();
        HueStream.socket.write(packet);
      }, Math.floor(1000 / localStorage['interval']));
    });
  },

  stopSocket: async function() {
    if (!this.socket) { return }

    await this.socket.close();
    this.socket = null;

    if (this.streamLoop) {
      clearInterval(this.streamLoop);
      this.streamLoop = null;
    }
    await this.setStreamingMode(false);
    console.log('Disconnected from Hue Stream');
  }
}


const GameStream = {
  socket: null,
  error: false,
  inWall: false,
  useBoost: false,

  startSocket: function() {
    if (this.socket) { return }
    this.socket = new WebSocket('ws://localhost:6557/socket');

    this.socket.onopen = function() {
      console.log('Connected to Beat Saber');
      $('#gamestatus').html('Connected to Beat Saber');

      HueStream.startSocket();
    }

    this.socket.onclose = function() {
      if (!this.error) { $('#gamestatus').html('Not Connected') }
      $('#start').html('Start').prop('disabled', false);
      this.socket = null;
      this.error = false;
    }

    this.socket.onerror = function() {
      $('#gamestatus').html('Failed to connect! Ensure <a href="https://github.com/denpadokei/HttpSiraStatus" target="_blank">SiraStatus</a> is installed.');
      $('#start').html('Start').prop('disabled', false);
      this.socket = null;
      this.error = true;
    }

    this.socket.onmessage = function(msg) {
      try { GameStream.handleEvent(JSON.parse(msg.data)) }
      catch (err) { return }
    }
  },

  stopSocket: async function() {
    if (!this.socket) { return }
    await this.socket.close();
    this.socket = null;
  },

  mapEvent: function(key, event) {
    if (event['boostColorsAreOn'] !== undefined) {
      this.useBoost = event['boostColorsAreOn'];
    }

    const lcol = this.useBoost ? localStorage['lcol2'] : localStorage['lcol'];
    const rcol = this.useBoost ? localStorage['rcol2'] : localStorage['rcol'];
    const bri = parseInt(localStorage['basebri']);

    if (event['boostColorsAreOn'] !== undefined) {
      $('#lcol').val(lcol);
      $('#rcol').val(rcol);
      $('#defcols').css('background-image',
        `radial-gradient(ellipse at 25% 80%,${lcol}80,transparent 60%),
       radial-gradient(ellipse at 75% 80%,${rcol}80,transparent 60%)`);
    }

    const value = event['value'];
    const time = Math.ceil(1000 * (event['nextSameTypeEventData']['time'] - event['time']));

    App.Events[key].changeLights((light, event) => {
      switch (value) {
        case 0: // off
          light.change({ bri: 0, boost: 0 }, 0);
          break;
        case 1: // on blue
          light.change({ hex: rcol, bri: bri }, 0);
          break;
        case 2: // flash blue
          light.change({ hex: rcol, bri: bri, boost: 48 }, 0);
          light.change({ hex: rcol, boost: 0 },
            Math.max(Math.min(time, 500), 150));
          break;
        case 3: // fade blue
          light.change({ hex: rcol, bri: bri }, 0);
          light.change({ hex: rcol, bri: 0 },
            Math.max(Math.min(time, 600), 150));
          break;
        case 5: // on red
          light.change({ hex: lcol, bri: bri }, 0);
          break;
        case 6: // flash red
          light.change({ hex: lcol, bri: bri, boost: 48 }, 0);
          light.change({ hex: lcol, boost: 0 },
            Math.max(Math.min(time, 500), 150));
          break;
        case 7: // fade red
          light.change({ hex: lcol, bri: bri }, 0);
          light.change({ hex: lcol, bri: 0 },
            Math.max(Math.min(time, 600), 150));
          break;
      }
    });
  },

  handleEvent: function(eventData) {
    if (this.inWall && !['obstacleExit', 'failed', 'menu'].includes(eventData['event'])) { return }

    switch (eventData['event']) {
      case 'beatmapEvent':
        if (!eventData['beatmapEvent']) { return }

        const event = eventData['beatmapEvent'];
        switch (eventData['beatmapEvent']['type']) {
          case 0: this.mapEvent('bla', event); break;
          case 1: this.mapEvent('rng', event); break;
          case 2: this.mapEvent('lla', event); break;
          case 3: this.mapEvent('rla', event); break;
          case 4: this.mapEvent('bgc', event); break;
          case 6: this.mapEvent('cl2', event); break;
          case 7: this.mapEvent('cl3', event); break;
          case 10: this.mapEvent('cl4', event); break;
          case 11: this.mapEvent('cl5', event); break;
        }
        break;

      case 'noteCut':
        App.Events['slc'].changeLights((light, event) => {
          light.change({ boost: 32 }, 0);
          light.change({ boost: 0 }, event.getSpeed());
        }); break;

      case 'noteMissed':
        App.Events['mss'].changeLights((light, event) => {
          light.change({ hex: event.getColor(), bri: parseInt(localStorage['basebri']) }, 0, true);
          light.change({ bri: 0 }, 1000 * event.getSpeed(), true);
        }); break;

      case 'bombCut':
        App.Events['bmb'].changeLights((light, event) => {
          light.change({ hex: event.getColor(), bri: parseInt(localStorage['basebri']) }, 0, true);
          light.change({ bri: 0 }, 1000 * event.getSpeed(), true);
        }); break;

      case 'obstacleEnter':
        App.Events['wal'].changeLights((light, event) => {
          if (!event.config.enabled) { return }
          GameStream.inWall = true;
          light.change({ hex: event.getColor(), bri: parseInt(localStorage['basebri']) }, 150, true);
        }); break;

      case 'obstacleExit':
        GameStream.inWall = false;
        App.Events['wal'].changeLights((light, event) => {
          light.change({ bri: 0 }, 500, true);
        }); break;

      case 'failed':
        console.log('Song Failed');

        if (GameStream.inWall) {
          GameStream.inWall = false;
          App.Events['wal'].changeLights((light, event) => {
            light.change({ bri: 0 }, 500, true);
          });
        }

        App.Events['fal'].changeLights((light, event) => {
          light.change({ hex: event.getColor() }, 2000);
        }); break;

      case 'songStart':
        App.Events['all'].changeLights((light, event) => {
          light.change({ bri: 0 }, 2000);
        });

        const details = eventData['status']['beatmap'];
        console.log(details['songAuthorName'] + ' - ' + details['songName']);

        if (JSON.parse(localStorage['autocols'])) {
          const lcol = details['color']['environment0']; $('#lcol').val(Color.rgbToHex(lcol));
          const rcol = details['color']['environment1']; $('#rcol').val(Color.rgbToHex(rcol));
          localStorage['lcol2'] = Color.rgbToHex(details['color']['environment0Boost'] || lcol);
          localStorage['rcol2'] = Color.rgbToHex(details['color']['environment1Boost'] || rcol);
          $('#lcol').change();
          App.Events['mss'].default.colorValue = Color.rgbToHex(details['color']['obstacle']);
        }

        if (localStorage['mode'] == 'overlay') {
          Overlay.setInfo({
            title: details['songName'],
            author: details['songAuthorName'],
            difficulty: details['difficulty'],
            image: details['songCover'],
            duration: details['length']
          });
          Overlay.startTimer(details['start']);
        } break;

      case 'scoreChanged':
        if (localStorage['mode'] == 'overlay') {
          const details = eventData['status']['performance'];
          Overlay.setScore(details['score'], details['currentMaxScore'], details['rank']);
        } break;

      case 'pause':
        Overlay.pauseTimer();
        break;

      case 'resume':
        Overlay.startTimer(eventData['status']['beatmap']['start']);
        break;

      case 'finished':
        Overlay.stopTimer();
        break;

      case 'menu':
        console.log('Returning to Menu');
        Overlay.stopTimer();

        if (GameStream.inWall) {
          GameStream.inWall = false;
          App.Events['wal'].changeLights((light, event) => {
            light.change({ bri: 0 }, 500, true);
          });
        }

        App.Events['all'].changeLights((light, event) => {
          light.change({ xy: light.default.xy, hex: '', bri: light.default.bri }, 2000);
        }); break;
    }
  }
}


class Event {
  constructor(key, title, { enabled = false, hidden = false, useSpeed = false, speedValue = 0.4, useColor = false, colorValue = '#C81414' }, ) {
    this.key = key;
    this.title = title;
    this.useSpeed = useSpeed;
    this.useColor = useColor;
    this.element = null;

    if (!localStorage[key]) { localStorage[key] = JSON.stringify({}) };
    let config = JSON.parse(localStorage[key]);
    if (Array.isArray(config)) { config = this.parseOldFormat(config) };

    this.default = {
      speedValue: speedValue,
      colorValue: colorValue
    }

    this.config = {
      enabled: config.enabled ?? enabled,
      lightGroups: config.lightGroups ?? [1, 2, 3, 4],
      speedCheck: config.speedCheck ?? false,
      speedValue: config.speedValue ?? speedValue,
      colorCheck: config.colorCheck ?? false,
      colorValue: config.colorValue ?? colorValue
    }

    App.Events[key] = this;
    localStorage[key] = JSON.stringify(this.config);
    if (!hidden) { $('#eventlist').append(this.getElement()) };
    $(`#eventlist #${this.key} select`).val(JSON.stringify(this.config.lightGroups));
  }

  parseOldFormat(config) {
    return {
      lightGroups: config[0].split('').map(i => parseInt(i)),
      speedCheck: config[1],
      speedValue: config[2],
      colorCheck: config[3],
      colorValue: config[4],
      enabled: config[5]
    };
  }

  getSpeed() {
    return this.config.speedCheck ? this.config.speedValue : this.default.speedValue;
  }

  getColor() {
    return this.config.colorCheck ? this.config.colorValue : this.default.colorValue;
  }

  getElement() {
    const config = this.config;
    const extra = JSON.parse(localStorage['moregroups'] || 'false');
    const el = $(
      `<li id="${this.key}" class="list-item" ${config.enabled ? '' : 'style="filter: opacity(0.75)"'}>
        <div class="subpanel item-header space-between" style="${config.enabled ? 'border-radius: 10px 10px 0px 0px;' : 'border-radius: 10px;'}">
          <div>
            <input type="checkbox" ${config.enabled ? 'checked' : ''}>
            <span style="margin-right: 20px;">${this.title}</span>
          </div>
          <div>
            <span style="font-weight: 400;">Group:</span>
            <select value="${JSON.stringify(config.lightGroups)}" selected>
              ${extra ? '<option value="[1,2,3,4,5,6]">1-6</option>' : ''}
              <option value="[1,2,3,4]">1-4</option>
              <option value="[1,2]">1-2</option>
              <option value="[1]">1</option>
              <option value="[2]">2</option>
              <option value="[3]">3</option>
              <option value="[4]">4</option>
              ${extra ? '<option value="[5]">5</option><option value="[6]">6</option>' : ''}
            </select>
          </div>
        </div>

        <div class="item-body indent" ${config.enabled ? '' : 'style="display:none;"'}></div>
      </li>`
    );

    const event = this;
    el.find('input').on('change', function() {
      if ($(this).is(':checked')) {
        $(this).parents('.item-header').stop().animate({ BorderBottomLeftRadius: '0px', BorderBottomRightRadius: '0px' }, 250);
        $(this).parents('.list-item').css('filter', 'none').find('.item-body').stop().slideDown(250);
      }
      else {
        $(this).parents('.list-item').css('filter', 'opacity(0.75)').find('.item-body').stop().slideUp(250);
        $(this).parents('.item-header').delay(250).stop().animate({ BorderRadius: '10px' }, 250);
      }
    });

    el.find('select, input').on('change', function() {
      config.enabled = el.find('input[type=checkbox]').prop('checked');
      config.lightGroups = JSON.parse(el.find('select').val());
      localStorage[event.key] = JSON.stringify(config);
    });

    if (this.useSpeed) { el.find('.item-body').append(this.getSpeedElement()) };
    if (this.useColor) { el.find('.item-body').append(this.getColorElement()) };

    this.element = el;
    return el;
  }

  getSpeedElement() {
    const config = this.config;
    const el = $(
      `<div class="item-option space-between">
        <div>
          <input type="checkbox" ${config.speedCheck ? 'checked' : ''}>
          <span>Custom Speed</span>
        </div>
        <input type="number" min="0.1" max="1" step="0.1" value="${config.speedValue}">
      </div>`
    );

    const event = this;
    el.find('input').on('change', function() {
      config.speedCheck = el.find('input[type=checkbox]').prop('checked');
      config.speedValue = el.find('input[type=number]').val();
      localStorage[event.key] = JSON.stringify(config);
    });

    return el;
  }

  getColorElement() {
    const config = this.config;
    const el = $(
      `<div class="item-option space-between">
        <div>
          <input type="checkbox" ${config.colorCheck ? 'checked' : ''}>
          <span>Custom Color</span>
        </div>
        <input type="color" value="${config.colorValue}">
      </div>`
    );

    const event = this;
    el.find('input').on('change', function() {
      config.colorCheck = el.find('input[type=checkbox]').prop('checked');
      config.colorValue = el.find('input[type=color]').val();
      localStorage[event.key] = JSON.stringify(config);
    });

    return el;
  }

  getLights() {
    return Object.assign({}, ...this.config.lightGroups.map(i => App.Groups[i].lights));
  }

  changeLights(callback) {
    if (!this.config.enabled) { return }
    Object.values(this.getLights()).forEach(light => callback(light, this));
    // const event = this;
    // $({ bri: 1.1 }).animate({ bri: 1 }, {
    //   duration: 250, step: function() {
    //     $(event.element).css({ 'filter': `brightness(${this.bri})` });
    //   }
    // });
  }
}


class LightGroup {
  constructor(id) {
    this.id = id;
    this.lights = {};
    this.element = null;

    App.Groups[id] = this;
    $('#group-grid').append(this.getElement());
  }

  getElement() {
    const el = $(
      `<ol id="group${this.id}" class="group indent">
        <p class="group-info" style="position:absolute;top:5px;right:8px;opacity:0.5;">${this.id}</p>
        <p class="group-info">Drag lights<br>to add</p>
      </ol>`
    );

    el.on('dragover', function(event) {
      event.preventDefault();
      event.stopPropagation();
    });

    const group = this;
    el.on('drop', function(event) {
      event.preventDefault();
      const light = App.dragData;
      App.dragData = null;

      if (Object.keys(group.lights).includes(light.id)) { return }

      $(this).find('.group-info').hide();
      $(this).append(light.getGroupElement());
      group.lights[light.id] = light;

      const groups = JSON.parse(localStorage['groups']);
      groups[group.id] = Object.keys(group.lights);
      localStorage['groups'] = JSON.stringify(groups);
    });

    el.data('group', this);
    this.element = el;
    return el;
  }
}


class Light {
  constructor(id, info) {
    this.id = id;
    this.info = info;
    this.elements = [];

    const state = this.info.state;

    state.xy = state.xy || [0, 0];
    state.bri = state.on ? state.bri : 0;

    this.default = {
      xy: state.xy,
      bri: state.bri
    }

    this.state = {
      x: state.xy[0],
      y: state.xy[1],
      bri: state.bri,
      hex: null, boost: 0
    }

    this.overlay = {
      x: state.xy[0],
      y: state.xy[1],
      bri: 0, hex: null
    }

    App.Lights[id] = this;
    $('#lightbar').append(this.getBarElement());
  }

  getState() {
    let x = this.state.x * (1 - (this.state.boost / 254));
    let y = this.state.y * (1 - (this.state.boost / 254));
    let bri = Math.min(this.state.bri + this.state.boost, 254);
    const basebri = parseInt(localStorage['basebri']);

    if (this.overlay.bri > 0) {
      if (this.state.bri < 1) {
        x = this.overlay.x;
        y = this.overlay.y;
        bri = this.overlay.bri;
      }
      else {
        const fac = this.overlay.bri / basebri;
        x = Color.blend(x, this.overlay.x, fac);
        y = Color.blend(y, this.overlay.y, fac);
        bri = Math.max(bri, this.overlay.bri);
      }
    }

    if (JSON.parse(localStorage['overlay'])) {
      const max = Math.max(this.state.bri, this.overlay.bri);
      const fac = parseInt(localStorage['opacity']) * (max / basebri);
      x = Color.blend(this.default.xy[0], x, fac / 100);
      y = Color.blend(this.default.xy[1], y, fac / 100);
      if (this.id == 1) {
        $('#gamestatus').html(this.default.bri + ', ' + Math.floor(this.state.boost));
      }
      bri = Math.min(Math.min(this.default.bri, basebri) + this.state.boost, 254);
    }

    return { x: x, y: y, bri: bri };
  }

  // data = { xy?, hex?, bri?, boost? }
  change(data, transition, overlay = false) {
    const state = (overlay ? this.overlay : this.state);

    if (data.xy) {
      [data.x, data.y] = data.xy;
      delete data.xy;
    }

    if (data.hex && !data.xy) {
      [data.x, data.y] = Color.hexToXY(data.hex);
      state.hex = data.hex;
      delete data.hex;
    }

    const light = this;
    function changeIcon() {
      const bri = 254 * (Math.max(light.state.bri, light.overlay.bri) / parseInt(localStorage['basebri']));
      const hex = state.hex;
      const color = hex + Math.floor(bri).toString(16);
      $(`[id=${light.id}]:visible svg`).css(
        (bri >= 1) ?
          { 'fill': color, 'filter': `drop-shadow(2px 2px 8px ${hex})` } :
          { 'fill': '', 'filter': '' }
      );
    }

    if (transition > 0) {
      $(state).animate(data, {
        duration: transition, queue: false, easing: 'linear', progress: changeIcon
      });
    }
    else {
      Object.assign(state, data);
      changeIcon();
    }
  }

  static getIcon(archetype) {
    let icon;
    switch (archetype) {
      case 'sultanbulb':
        icon = 'M16.727 4.047c1.144 1.055.105 2.988-.247 3.68-.94.277-2.453.523-4.48.523-2.031 0-3.54-.246-4.48-.523-.352-.692-1.391-2.625-.247-3.68C8.496 2.926 11.793 3 12 3c.207 0 3.504-.074 4.727 1.047ZM12 9c1.14 0 2.809-.11 4.152-.414-1.015 3.164-1.191 6.059-1.156 6.879a.745.745 0 0 1-.184.52l-.328.374c-.714.086-1.543.141-2.484.141-.941 0-1.77-.055-2.484-.14l-.329-.376a.745.745 0 0 1-.183-.52c.035-.82-.14-3.714-1.16-6.878C9.19 8.89 10.859 9 12 9Zm-2.25 8.145a24.114 24.114 0 0 0 4.504 0l-.375 2.332a.676.676 0 0 1-.227.43l-.347.32a.533.533 0 0 0-.067.066l-.37.437a.766.766 0 0 1-.59.27h-.548a.76.76 0 0 1-.59-.27l-.37-.437a.533.533 0 0 0-.067-.066l-.351-.32a.69.69 0 0 1-.223-.43Zm0 0';
        break;
      case 'huelightstrip':
        icon = 'M6.328 12.5a.756.756 0 0 1 .895.578.754.754 0 0 1-.575.89.756.756 0 0 1-.894-.573.756.756 0 0 1 .574-.895m3.668-.793a.752.752 0 0 1 .316 1.469.75.75 0 0 1-.316-1.469m3.664-.789a.75.75 0 1 1 .315 1.463.75.75 0 0 1-.315-1.463m3.664-.793a.75.75 0 1 1 .322 1.466.75.75 0 0 1-.322-1.466m-9.32 5.355 11.101-2.398a1.497 1.497 0 0 0 1.149-1.781 3.587 3.587 0 0 0-4.262-2.75L4.887 10.945a1.499 1.499 0 0 0-1.149 1.782 3.591 3.591 0 0 0 4.266 2.753M18.75 19.5a.75.75 0 1 1 0-1.5.75.75 0 0 1 0 1.5m-3.75 0a.75.75 0 1 1 0-1.5.75.75 0 0 1 0 1.5m-3.75 0a.75.75 0 1 1 0-1.5.75.75 0 0 1 0 1.5m-3.75 0a.75.75 0 1 1 0-1.5.75.75 0 0 1 0 1.5m12.75-3H6.75c-3 0-3.75-2.25-3.75-3v3.75C3 19.32 4.68 21 6.75 21h13.5a.75.75 0 0 0 .75-.75v-3a.75.75 0 0 0-.75-.75M16.5 6a.75.75 0 1 1 0-1.5.75.75 0 0 1 0 1.5m-3.75 0a.75.75 0 1 1 0-1.5.75.75 0 0 1 0 1.5M9 6a.75.75 0 1 1 0-1.5A.75.75 0 0 1 9 6M5.25 6a.75.75 0 1 1 0-1.5.75.75 0 0 1 0 1.5m12-3H3.75a.75.75 0 0 0-.75.75v3c0 .414.336.75.75.75h13.5c3 0 3.75 2.25 3.75 3V6.75C21 4.68 19.32 3 17.25 3';
        break;
      case 'hueplay':
        icon = 'M21.733 14.499c-1.597.79-3.167.203-4.216-.21-.868-.342-15.359-6.317-15.359-6.317s-1.337-.597.123-1.127c1.8-.655 3.254-.112 4.934.563l14.132 5.674s1.982.627.386 1.417zm1.512-.667c-.013-.364-.2-1.01-1.273-1.45L6.508 6.171c-.654-.268-1.682-.437-2.677-.437-.514 0-1.25.047-1.839.274-1.04.4-1.25.996-1.275 1.353L.712 7.36l-.006 4.268.004.001c.021.343.207.888 1.095 1.268l15.877 6.53c.596.254 1.382.397 2.207.397.827 0 1.607-.145 2.196-.405 1.016-.45 1.16-1.099 1.157-1.446l.005-4.14z';
        break;
      case 'huebloom':
      case 'hueiris':
      case 'tablewash':
      case 'huego':
        icon = 'M17.152 15.758c-2.894-2.043-6.851-6.004-8.898-8.903-2.074-2.937-1.441-3.73 1.473-1.707 2.957 2.051 7.07 6.168 9.12 9.13 2.028 2.917 1.239 3.554-1.695 1.48m2.723-1.742c-2.086-3.41-6.484-7.809-9.89-9.895-1.614-.988-2.731-1.32-3.258-1.008C4.488 4.93 3 7.97 3 11.078a9.908 9.908 0 0 0 3.629 7.672h-.254c-.617 0-1.125.504-1.125 1.125A1.13 1.13 0 0 0 6.375 21h5.902a.919.919 0 0 0 .211-.023c.145.007.282.023.426.023 3.066 0 6.156-1.527 7.973-3.719.312-.527-.024-1.648-1.012-3.265';
        break;
      case 'groundspot':
      case 'wallspot':
      case 'singlespot':
      case 'doublespot':
        icon = 'M16.313 10.715c-.895.316-2.098-.774-2.68-2.43-.586-1.66-.336-3.258.562-3.574.895-.316 2.094.77 2.68 2.43.586 1.656.332 3.257-.563 3.574m1.965-4.074c-.875-2.43-2.668-4.024-4.004-3.563L5.367 7.223c-1.015.394-1.16 2.398-.32 4.476.844 2.082 2.574 3.563 3.59 3.168l1.117-.41v2.813c-2.195.082-3.961.527-4.395 1.105a.459.459 0 0 0-.105.281v.938c0 .777 2.351 1.406 5.25 1.406 2.898 0 5.246-.629 5.246-1.406v-.938c0-.707-1.957-1.293-4.496-1.39v-3.313l6.184-2.07c1.34-.465 1.714-2.813.84-5.242';
        break;
      default:
        icon = 'M7.18 9.906c1.414.45 3.48.594 4.82.594 1.34 0 3.406-.145 4.82-.594-.574 1.512-1.574 2.184-1.812 3.594-.106.613-.192 1.473-.133 2.102a.738.738 0 0 1-.668.789c-.648.066-1.383.109-2.207.109-.824 0-1.559-.043-2.207-.11a.735.735 0 0 1-.668-.788c.059-.63-.027-1.489-.133-2.102-.238-1.41-1.234-2.082-1.812-3.594Zm2.57 7.242c.781.075 1.64.102 2.25.102.61 0 1.469-.027 2.25-.102l-.375 2.329a.694.694 0 0 1-.227.43l-.347.32a.533.533 0 0 0-.067.066l-.37.437a.76.76 0 0 1-.59.27h-.547a.76.76 0 0 1-.59-.27l-.371-.437a.533.533 0 0 0-.067-.066l-.347-.32a.694.694 0 0 1-.227-.43ZM12 3c2.89 0 5.25 2.5 5.25 4.875 0 .215-.043.406-.063.605a5.267 5.267 0 0 1-.097.528c-.817.347-2.55.742-5.09.742s-4.273-.395-5.09-.742a5.267 5.267 0 0 1-.098-.528c-.019-.199-.062-.39-.062-.605C6.75 5.5 9.11 3 12 3Zm0 0';
    }
    return icon;
  }

  getBarElement() {
    const active = this.info.state.reachable;
    const el = $(
      `<div id="${this.id}" class="light-icon" draggable="${active}" style="${active ? 'cursor:move;' : 'color:#9AA1B1;cursor:not-allowed;'}" ${active ? '' : 'title="Not Reachable"'}>
        <svg viewBox="2 2 21 21" xmlns="http://www.w3.org/2000/svg" title="${this.info.productname}" ${active ? '' : 'style="fill:#9AA1B1;"'}>
          <path d="${Light.getIcon(this.info.config.archetype)}"/>
        </svg>
        <span>${this.info.name}</span>
      </div>`
    );

    const light = this;
    el.on('dragstart', function() {
      App.dragData = light;
      if (['lightbar', 'overlay'].includes(localStorage['mode'])) {
        App.setMode('mini');
      }
    });

    this.elements.push(el);
    return el;
  }

  getGroupElement() {
    const active = this.info.state.reachable;
    const el = $(
      `<li id="${this.id}">
        <svg viewBox="2 2 21 21" xmlns="http://www.w3.org/2000/svg" title="${this.info.productname}" ${active ? '' : 'style="fill:#9AA1B1;"'}>
          <path d="${Light.getIcon(this.info.config.archetype)}"/>
        </svg>
        <span>${this.info.name}</span>
        <button class="remove">✖</button>
      </li>`
    );

    el.find('.remove').on('click', function() {
      const light = el.data('light');
      const group = el.parents('.group').data('group');

      delete group.lights[light.id];
      el.remove();

      const groups = JSON.parse(localStorage['groups']);
      groups[group.id] = Object.keys(group.lights);
      localStorage['groups'] = JSON.stringify(groups);

      if (!Object.keys(group.lights).length) {
        $(group.element).find('.group-info').fadeIn(250);
      }
    });

    el.data('light', this);
    this.elements.push(el);
    return el;
  }
}


const Overlay = {
  timer: null,
  duration: 0,
  progress: 0,

  setInfo: function({ title, author, difficulty, image, duration }) {
    $('#ol-title').html(title ?? 'Main Menu');
    $('#ol-author').html(author ?? 'Beat Saber');
    $('#ol-difficulty').html(difficulty ?? 'N/A');
    $('#ol-image').css('background-image', 'url(data:image/png;base64,' + image ?? '' + ')');
    $('#ol-duration').html(new Date(duration ?? 0).toISOString().substr(14, 5));
    this.duration = duration;
  },

  setScore: function(score, maxScore, rank) {
    if (!score || !maxScore || !rank) { return }
    $('#ol-score').html(score).stop().css({ 'font-size': '21px' }).animate({ 'font-size': '18px' }, 250);
    $('#ol-rank').html(`${((score / maxScore) * 100).toFixed(1)}% ${rank}`);
  },

  startTimer: function(startTime) {
    const overlay = this;
    this.timer = setInterval(function() {
      overlay.progress = Date.now() - startTime;
      $('#ol-time').html(new Date(overlay.progress).toISOString().substr(14, 5));
      $('#ol-bar-fill').css({ 'width': (overlay.progress / overlay.duration) * 100 + '%' });
    }, 1000);
  },

  pauseTimer: function() {
    clearInterval(this.timer);
    this.timer = null;
  },

  stopTimer: function() {
    $('#ol-time').html('00:00');
    $('#ol-bar-fill').animate({ 'width': '0%' }, 500);
    clearInterval(this.timer);
    this.timer = null;
    this.duration = this.progress = 0;
  }
}


const App = {
  Lights: { /* id: Light{} */ },
  Events: { /* key: Event{} */ },
  Groups: { /* id: lightGroup{} */ },
  optionsPage: 1,
  dragData: null,

  init: async function() {
    $('#filter, #panel-intro, #intro-icon, #panel-bridge, #panel-options, #panel-overlay').hide();
    this.createLightGroups();
    this.createEvents();
    this.setMode(localStorage['mode'] || 'full');
    this.setTheme(localStorage['theme'] || 'light');
    this.bindEventHandlers();
    this.loadPreferences();

    if (!await this.doAuthFlow()) { return }

    const config = await Hue.getBridgeConfig(localStorage['bridgeIp']);
    $('#hubstatus').html(`Connected to Bridge: ${config['name']}`);

    $('#lightbar .light-icon').hide();
    await Hue.getLights(localStorage['bridgeIp'], localStorage['apiKey']);

    this.importLights();

    $('#loading').fadeOut(250);
    if (JSON.parse(localStorage['autostart'])) { $('#start').click() }
  },

  doAuthFlow: async function() {
    if (
      (localStorage['bridgeIp'] && localStorage['apiKey']) &&
      (await Hue.testKey(localStorage['bridgeIp'], localStorage['apiKey']))
    ) { return true }

    if (['mini', 'lightbar', 'overlay'].includes(localStorage['mode'])) { App.setMode('half') }
    $('#loading').fadeOut(150);

    const bridges = await Hue.getBridges();
    if (bridges.length == 0) {
      console.warn('No bridge found!');
      $('#intro-main').html('Unfortunately, no bridge was detected.<br>Ensure it is active and on the same network.');
      $('#intro-sub').html('Reload or restart this application to try again.');
      $('#intro-status').html('⚠ Not Found');
      $('#filter, #panel-intro').fadeIn(750);
      return false;
    }

    let bridgeIp;

    if (bridges.length > 1) {
      bridgeIp = await new Promise(resolve => {
        bridges.forEach(async (bridge) => {
          const ip = bridge['internalipaddress'];
          const config = await Hue.getBridgeConfig(ip);
          const button = $(
            `<button class="subpanel">
                <span>${config['name']}</span>
                <span>(${ip})</span>
              </button>`
          );
          button.on('click', () => { resolve(ip) });
          $('#panel-bridge div').prepend(button);
        });
        $('#panel-bridge').fadeIn(500);
      });
      $('#panel-bridge').fadeOut(250);
    }

    else {
      bridgeIp = bridges[0]['internalipaddress'];
    }

    $('#filter, #panel-intro').fadeIn(750);
    console.log('Waiting for button press...');
    const success = await Hue.authorizeBridge(bridgeIp);

    if (!success) {
      console.warn('Authorization timed out');
      $('#intro-main').html('Something went wrong!<br>The Bridge button must be pressed to grant permission.');
      $('#intro-sub').html('Reload or restart this application to try again.');
      $('#intro-status').html('⚠ Timed Out');
      return false;
    }

    console.log('Authorization Successful');
    $('#filter, #panel-intro').fadeOut(250);
    localStorage['bridgeIp'] = bridgeIp;
    return true;
  },

  createLightGroups: function() {
    const extra = JSON.parse(localStorage['moregroups'] || 'false');
    const max = extra ? 6 : 4;
    for (let i = 1; i < (max + 1); i++) { new LightGroup(i) }
    if (extra) { $("#group-grid").addClass('extra') }
  },

  importLights: function() {
    const groups = JSON.parse(localStorage['groups']);
    for (const [id, group] of Object.entries(App.Groups)) {
      if (!groups[id]) { continue }
      for (const light of groups[id]) {
        if (!App.Lights[light]) { continue }
        App.dragData = App.Lights[light];
        $(group.element).trigger('drop');
      }
    }
  },

  createEvents: function() {
    new Event('all', 'All Lights', { enabled: true, hidden: true });
    $('#eventlist').append('<p style="margin-top:10px;">Player Events</p>');
    new Event('slc', 'Note Slice', { useSpeed: true, speedValue: 0.3 });
    new Event('mss', 'Note Miss', { enabled: true, useSpeed: true, useColor: true });
    new Event('bmb', 'Bomb Hit', { useSpeed: true, speedValue: 0.6, useColor: true });
    new Event('wal', 'In Wall', { useColor: true });
    new Event('fal', 'Fail', { enabled: true, useColor: true });
    $('#eventlist').append('<p>Map Events</p>');
    new Event('bgc', 'Center Lights', {});
    new Event('rng', 'Ring Lights', {});
    new Event('bla', 'Back Lasers', {});
    new Event('lla', 'Left Lasers', {});
    new Event('rla', 'Right Lasers', {});
    // $('#eventlist').append('<p>Special Events</p>');
    // new Event('scr', 'Cut Score', { useSpeed: true });
    // new Event('grd', 'Level Score', {});
    $('#eventlist').append('<p>Other Events <span class="help" title="Used by some scenes for extra effects,&#10;their locations may vary.">?</span></p>');
    new Event('cl2', 'Custom Light 1', {});
    new Event('cl3', 'Custom Light 2', {});
    new Event('cl4', 'Custom Light 3', {});
    new Event('cl5', 'Custom Light 4', {});
  },

  setTheme: function(name) {
    if (!localStorage['themes']) {
      let data = fs.readFileSync(path.resolve(__dirname, 'theme.json'), { encoding: 'utf8' });
      localStorage['themes'] = JSON.stringify(JSON.parse(data));
    }

    localStorage['theme'] = name;
    const data = JSON.parse(localStorage['themes']);
    const theme = data[name] || data['light'];
    $('#theme').val(name);

    const vars = ['background', 'foreground1', 'foreground2', 'border1', 'border2', 'indent', 'shadow1', 'shadow2', 'dark', 'mid1', 'mid2', 'high'];
    for (const [i, e] of vars.entries()) {
      $(':root').css(`--${e}`, theme[i]);
      $(`#theme-${e}`).val(theme[i].substring(0, 7) || '#ffffff');
    }
  },

  addTheme: function(name, colors) {
    if (!localStorage['themes']) {
      let data = fs.readFileSync(path.resolve(__dirname, 'theme.json'), { encoding: 'utf8' });
      localStorage['themes'] = JSON.stringify(JSON.parse(data));
    }

    let data = JSON.parse(localStorage['themes']);
    data[name] = colors;
    localStorage['themes'] = JSON.stringify(data);
  },

  setMode: function(type) {
    localStorage['mode'] = type;
    $('#minify').val(type);

    // Reset elements
    $('#panel-overlay').hide();
    $('#panel-config, #panel-events, #option-opacity, #theme-text, #group-grid').show().children().show();
    $('#lightbar').css({ 'min-height': '', 'max-height': '', 'overflow-y': '' });
    $('#group-grid').css({ 'grid-template': '', 'height': '' });
    $('#option-pin').attr('class', 'subpanel option top');
    $('#theme-window').attr('class', 'subpanel option top');
    $('#p3-spacer').css('height', '65px');
    $('.panel').css('padding', '');

    switch (type) {
      default:
        localStorage['mode'] = 'full';
        $('#minify').val('full');
      case 'full':
        ipcRenderer.send('resize', 640, 485, 760, 485, 1000, 485);
        $('#group-grid').removeClass('half');
        $('#intro-icon').show();
        break;

      case 'half':
        ipcRenderer.send('resize', 350, 485, 380, 485, 600, 485);
        $('#group-grid').addClass('half');
        $('#panel-intro').css({ 'width': '100%' });
        $('#panel-events').hide();
        break;

      case 'mini':
        ipcRenderer.send('resize', 350, 295, 380, 295, 600, 295);
        $('#panel-events, #hubstatus, #defcols, #group3, #group4, #group5, #group6, #option-opacity, #theme-text').hide();
        $('#group-grid').css({ 'grid-template': '1fr / 1fr 1fr', 'height': '80px' });
        $('#option-pin').attr('class', 'subpanel option midy');
        $('#theme-window').attr('class', 'subpanel option');
        $('#p3-spacer').css('height', '0px');
        break;

      case 'lightbar':
        ipcRenderer.send('resize', 350, 84, 400, 84, 800, 84);
        $('#groups, #buttons, #gamestatus, #panel-events, #hubstatus, #defcols').hide();
        $('#filter, #panel-options').hide();
        $('#lightbar').css({ 'min-height': 'none', 'max-height': '64px', 'overflow-y': 'hidden' });
        $('.panel').css('padding', '8px');
        break;

      case 'overlay':
        let lights = $('#lightbar .light-icon').clone(true);
        lights.find('span').remove();
        $('#ol-lightbar').empty().append(lights);

        ipcRenderer.send('resize', 420, 146, 460, 146, 600, 146);
        $('#panel-config, #panel-events').hide();
        $('#filter, #panel-options').hide();
        $('.panel').css('padding', '8px');
        $('#panel-overlay').show();
    }
  },

  readJSON: async function(name) {
    const options = {
      multiple: false,
      excludeAcceptAllOption: true,
      suggestedName: name,
      types: [{ accept: { 'application/json': ['.json'] } }]
    };

    const path = await window.showOpenFilePicker(options);
    const file = await path[0].getFile();
    const text = await file.text();

    return text;
  },

  writeJSON: async function(name, data) {
    const options = {
      excludeAcceptAllOption: true,
      suggestedName: name,
      types: [{ accept: { 'application/json': ['.json'] } }]
    };

    const path = await window.showSaveFilePicker(options);
    const stream = await path.createWritable();
    const blob = new Blob([data], { type: 'application/json' });

    await stream.write(blob);
    await stream.close();
  },

  loadPreferences: function() {
    const prefs = {
      'lcol': $('#lcol').val(),
      'rcol': $('#rcol').val(),
      'autocols': true,
      'autostart': false,
      'basebri': $('#basebri').val(),
      'overlay': $('#overlay').prop('checked'),
      'opacity': $('#overlay-opacity').val(),
      'ontop': $('#ontop').prop('checked'),
      'theme': $('#theme').val(),
      'interval': $('#interval').val(),
      'moregroups': $('#moregroups').prop('checked'),
      'groups': JSON.stringify({})
    }

    for (const [key, value] of Object.entries(prefs)) {
      localStorage[key] = localStorage[key] || value;
    }

    $('#lcol').val(localStorage['lcol']);
    $('#rcol').val(localStorage['rcol']);
    if (JSON.parse(localStorage['autocols'])) { $('#autocols').addClass('button-toggle') }
    if (JSON.parse(localStorage['autostart'])) { $('#autostart').addClass('button-toggle') }
    $('#basebri').val(localStorage['basebri']);
    $('#overlay').prop('checked', JSON.parse(localStorage['overlay']));
    $('#overlay-opacity').val(localStorage['opacity']);
    $('#ontop').prop('checked', JSON.parse(localStorage['ontop']));
    $('#theme').val(localStorage['theme']);
    $('#interval').val(localStorage['interval']);
    $('#moregroups').prop('checked', JSON.parse(localStorage['moregroups']));

    $('#lcol, #basebri, #theme, #ontop').change();
  },

  bindEventHandlers: function() {
    $('#start').on('click', async function() {
      if (GameStream.socket || HueStream.socket) {
        $(this).prop('disabled', true);
        await GameStream.stopSocket();
        await HueStream.stopSocket();
        $(this).html('Start').prop('disabled', false);
      }
      else {
        $(this).prop('disabled', true);
        $('#gamestatus').html('Connecting...');
        await GameStream.startSocket();
      }
    });

    ipcRenderer.on('close', async function() {
      console.log('Closing Connections...');
      await GameStream.stopSocket();
      await HueStream.stopSocket();
      ipcRenderer.send('close');
    });
    $('#exit').on('click', async function() {
      window.close();
    });

    $('#reload').on('click', async function() {
      $(this).prop('disabled', true);
      if (GameStream.socket || HueStream.socket) {
        await GameStream.stopSocket();
        await HueStream.stopSocket();
        setTimeout(function() {
          location.reload();
        }, 250);
      }
      else { location.reload() }
    });

    $('#autocols').on('click', function() {
      const current = JSON.parse(localStorage['autocols']);
      localStorage['autocols'] = !current;
      $(this).toggleClass('button-toggle');
    });

    $('#autostart').on('click', function() {
      const current = JSON.parse(localStorage['autostart']);
      localStorage['autostart'] = !current;
      $(this).toggleClass('button-toggle');
    });

    $('#defcols input').on('change', function() {
      const lcol = $('#lcol').val();
      const rcol = $('#rcol').val();
      localStorage['lcol'] = lcol;
      localStorage['rcol'] = rcol;
      $('#defcols').css('background-image',
        `radial-gradient(ellipse at 25% 80%,${lcol}80,transparent 60%),
       radial-gradient(ellipse at 75% 80%,${rcol}80,transparent 60%)`);
      console.log(`Light colors: %c${lcol} %c& %c${rcol}`, `color: ${lcol}`, 'color: inherit', `color: ${rcol}`);
    });

    $('#options').on('click', function() {
      $('#exit, #reload').css('z-index', '0');
      $('#filter, #panel-options').fadeIn(250);
    });

    $('#done').on('click', function() {
      $('#filter, #panel-options').fadeOut(250);
      $('#exit, #reload').css('z-index', '1');
    });

    $('#prev').on('click', function() {
      App.optionsPage == 1 ? App.optionsPage = 3 : App.optionsPage--;
      $('#options-p1, #options-p2, #options-p3').hide();
      $(`#options-p${App.optionsPage}`).show();
    });

    $('#next').on('click', function() {
      App.optionsPage == 3 ? App.optionsPage = 1 : App.optionsPage++;
      $('#options-p1, #options-p2, #options-p3').hide();
      $(`#options-p${App.optionsPage}`).show();
    });

    $('#basebri').on('change', function() {
      if ($(this).val() >= 254) { $('#briwarn').fadeIn(150) }
      else { $('#briwarn').fadeOut(150) }
      localStorage['basebri'] = $(this).val();
    });

    $('#overlay').on('change', function() {
      localStorage['overlay'] = $(this).prop('checked');
    });

    $('#overlay-opacity').on('change', function() {
      localStorage['opacity'] = $(this).val();
    });

    $('#ontop').on('change', function() {
      localStorage['ontop'] = $(this).prop('checked');
      ipcRenderer.send('ontop', JSON.parse($(this).prop('checked')));
    });

    $('#theme').on('change', function() {
      App.setTheme($(this).val());
    });

    $('#minify').on('change', function() {
      App.setMode($(this).val());
    });

    $('html').on('keydown', function(e) {
      if (e.key == 'Escape' && ['mini', 'lightbar', 'overlay'].includes(localStorage['mode'])) {
        App.setMode('half');
      }
    })

    $('#theme-import').on('click', async function() {
      localStorage['themes'] = await App.readJSON('huesaber_custom.json');
      App.setTheme('custom');
    });

    $('#theme-export').on('click', async function() {
      await App.writeJSON('huesaber_custom.json', localStorage['themes']);
    })

    $('#theme-reset').on('click', function() {
      localStorage.removeItem('themes');
      App.setTheme(localStorage['theme']);
    });

    $('#options-p2 input').on('input', function() {
      const vars = ['background', 'foreground1', 'foreground2', 'border1', 'border2', 'indent', 'shadow1', 'shadow2', 'dark', 'mid1', 'mid2', 'high'];
      let colors = [];

      for (const e of vars) {
        let color = $(`#theme-${e}`).val();
        color += (e == 'foreground2') ? '90' : (e == 'shadow1' || e == 'shadow2') ? '60' : '';
        colors.push(color);
      }

      App.addTheme('custom', colors);
      App.setTheme('custom');
    });

    $('#interval').on('change', function() {
      localStorage['interval'] = $(this).val();
    });

    $('#moregroups').on('change', function() {
      localStorage['moregroups'] = $(this).prop('checked');
    })

    $('#reset-prefs').on('click', function() {
      const apiKey = localStorage['apiKey'];
      const clientKey = localStorage['clientKey'];
      const bridgeIp = localStorage['bridgeIp'];
      localStorage.clear();
      localStorage['apiKey'] = apiKey;
      localStorage['clientKey'] = clientKey;
      localStorage['bridgeIp'] = bridgeIp;
      $('#reload').click();
    });

    let verify = false;
    $('#reset-hub').on('click', function() {
      if (!verify) {
        verify = true;
        $(this).html('Are You Sure?');

        const timer = window.setTimeout(function() {
          $("#reset-hub").html('Remove Bridge').off('click.verify');
          verify = false;
        }, 2000);

        $(this).on('click.verify', function() {
          $(this).off('click.verify').html('Resetting...');
          window.clearTimeout(timer);
          localStorage.removeItem('bridgeIp');
          localStorage.removeItem('apiKey');
          localStorage.removeItem('clientKey');
          $('#reload').click();
        });
      }
    });
  }
}


App.init();
