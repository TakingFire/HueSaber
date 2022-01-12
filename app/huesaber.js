const { ipcRenderer } = require('electron');
const { setTimeout } = require('timers'); // dtls dependency
require('binary-data');                   // dtls dependency
const dtls = require('@nodertc/dtls');
const { Buffer } = require('buffer');

const lightState = {};
const defState = {};
var webSocket = null;
var udpSocket = null;
var streamLoop = null;

function compilePacket() {
  packet = [
    Buffer.from('HueStream', 'ascii'),
    Buffer.from([
      0x01, 0x00, // version
      0x00,       // sequence
      0x00, 0x00, // reserved
      0x01,       // use xy
      0x00        // reserved
    ])
  ]

  let lights = getActiveLights().slice(0, 10);

  lights.forEach(function(id) {
    packet.push(lightBuffer(id));
  })

  return Buffer.concat(packet, 16 + (9 * lights.length));
}

function lightBuffer(id) {
  const arr = new ArrayBuffer(9);
  const view = new DataView(arr);
  var state = lightState[id]

  view.setUint8(0, 0);
  view.setUint16(1, parseInt(id));
  view.setUint16(3, parseInt(65535 * ((state['x'] * (1 - state['boost'] / 254)) + (state['x2'] * (state['bri2'] / 254)))));
  view.setUint16(5, parseInt(65535 * ((state['y'] * (1 - state['boost'] / 254)) + (state['y2'] * (state['bri2'] / 254)))));
  view.setUint16(7, parseInt(65535 * ((Math.min(Math.max(state['bri'], state['bri2']) + state['boost'], 254)) / 254)));

  return Buffer.from(arr);
}

function hexy(hex) {
  var rgb = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
  [r, g, b] = [parseInt(rgb[1], 16), parseInt(rgb[2], 16), parseInt(rgb[3], 16)];
  // Source: https://github.com/ArndBrugman/huepi/blob/gh-pages/huepi.js#L713
  if (r > 0.04045) { r = Math.pow((r + 0.055) / (1.055), 2.4) }
  else { r = r / 12.92 }
  if (g > 0.04045) { g = Math.pow((g + 0.055) / (1.055), 2.4) }
  else { g = g / 12.92 }
  if (b > 0.04045) { b = Math.pow((b + 0.055) / (1.055), 2.4) }
  else { b = b / 12.92 }
  var x = r * 0.664511 + g * 0.154324 + b * 0.162028;
  var y = r * 0.283881 + g * 0.668433 + b * 0.047685;
  var z = r * 0.000088 + g * 0.072310 + b * 0.986039;
  if ((x + y + z) === 0) { return [0, 0] }
  return [x / (x + y + z), y / (x + y + z)];
}

function getActiveLights(group = '1234') {
  let lights = [];
  group.split('').forEach(function(num) {
    $(`#group${num} li`).each(function(_, e) {
      if (!lights.includes(e.id) && lightState[e.id]['active'] == true) { lights.push(e.id) }
    })
  })
  return lights;
}

// data: { x, y, bri, x2, y2, bri2, boost }
function changeLight(key, data, transition, def = false) {
  if (key != 'all' && !$(`#${key} .item-header input[type=checkbox]`).is(':checked')) { return; }

  if ((data['hex'] || data['hex2']) && !def) {
    var xy = hexy(data['hex'] || data['hex2']);
    data['hex'] ? [data['x'], data['y']] = xy : [data['x2'], data['y2']] = xy;
    var hex = data['hex'] || data['hex2'];
    delete data['hex'] || data['hex2'];
  }

  getActiveLights($(`#${key} select`).val()).forEach(function(id) {
    function changeIcon() {
      let state = lightState[id];
      let bri = Math.max(state['bri'], state['bri2']);
      let color = hex + parseInt(bri).toString(16);
      $(`[id=${id}] svg`).css({ 'fill': bri <= 1 ? '' : color, 'filter': bri <= 1 ? '' : `drop-shadow(2px 2px 8px ${hex})` });
    }

    if (transition > 0) {
      $(lightState[id]).animate(def ? defState[id] : data, {
        duration: transition, queue: false, step: function() {
          changeIcon();
        }
      })
    }
    else {
      Object.assign(lightState[id], def ? defState[id] : data);
      changeIcon();
    }
  })
}

function mapEvent(key, value) {
  if (!$(`#${key} .item-header input[type=checkbox]`).is(':checked')) { return; }
  var lcol = localStorage['lcol'];
  var rcol = localStorage['rcol'];
  var bri = localStorage['basebri'];
  var over = JSON.parse(localStorage['overlay']);

  switch (value) {
    case 0:
      changeLight(key, { bri: 0 }, 0, over);
      break;
    case 1 || 2:
      changeLight(key, { hex: rcol, bri: bri }, 0);
      break;
    case 3:
      changeLight(key, { hex: rcol, bri: bri }, 0);
      changeLight(key, { hex: rcol, bri: 0 }, 750, over);
      break;
    case 5 || 6:
      changeLight(key, { hex: lcol, bri: bri }, 0);
      break;
    case 7:
      changeLight(key, { hex: lcol, bri: bri }, 0);
      changeLight(key, { hex: lcol, bri: 0 }, 750, over);
      break;
  }
}

function handleEvent(result) {
  var type = result['event'];
  var bri = (type != 'beatmapEvent') ? localStorage['basebri'] : null;
  var cache, speed, color;

  switch (type) {
    case 'beatmapEvent':
      let value = result['beatmapEvent']['value'];
      switch (result['beatmapEvent']['type']) {
        case 0: mapEvent('bla', value); break;
        case 1: mapEvent('rng', value); break;
        case 2: mapEvent('lla', value); break;
        case 3: mapEvent('rla', value); break;
        case 4: mapEvent('bgc', value); break;
      }
      break;

    case 'noteCut':
      cache = JSON.parse(localStorage['slc']);
      speed = cache[1] ? cache[2] : 0.4;

      changeLight('slc', { boost: 48 }, 0);
      changeLight('slc', { boost: 0 }, speed);
      break;

    case 'noteMissed':
      cache = JSON.parse(localStorage['mss']);
      speed = cache[1] ? cache[2] : 0.4;
      color = cache[3] ? cache[4] : '#C81414';

      changeLight('mss', { hex2: color, bri2: bri }, 0);
      changeLight('mss', { bri2: 0 }, 1000 * speed);
      break;

    case 'bombCut':
      cache = JSON.parse(localStorage['bmb']);
      speed = cache[1] ? cache[2] : 0.6;
      color = cache[3] ? cache[4] : '#C81414';

      changeLight('bmb', { hex2: color, bri2: bri }, 0);
      changeLight('bmb', { bri2: 0 }, 1000 * speed);
      break;

    case 'obstacleEnter':
      cache = JSON.parse(localStorage['wal']);
      color = cache[3] ? cache[4] : '#C81414';

      changeLight('wal', { hex2: color, bri2: bri }, 250);
      break;

    case 'obstacleExit':
      changeLight('wal', { bri2: 0 }, 500);
      break;

    case 'failed':
      color = $('#fal .color input[type=checkbox]').prop('checked') ? $('#fal .color input[type=color]').val() : '#C81414';

      console.log('%cFailed', `color: ${color}`);
      changeLight('fal', { hex: color, bri: bri }, 2000);
      break;

    case 'songStart':
      let details = result['status']['beatmap'];
      console.log(details['songAuthorName'] + ' - ' + details['songName']);

      if (!JSON.parse(localStorage['overlay'])) { changeLight('all', { bri: 0 }, 2000) }
      break;

    case 'menu':
      console.log('Returning to Menu');
      changeLight('all', {}, 2000, true);
      break;
  }
}

function lightIcon(archetype) {
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

function dragarea(e) {
  e.preventDefault();
}

var dragged;
function drag(e) {
  dragged = e.target;
  if ($('#minify').val() == 'lightbar') {
    $('#minify').val('mini');
    $('#minify').change();
  }
}

function insertLight(e, el) {
  if (!($(e.currentTarget).find('li').map(function() { return this.id; }).get().includes(dragged.id))) {
    e.preventDefault();
    $(el).find('p').hide();
    let item = `<li id="${dragged.id}">${dragged.innerHTML}<button class="remove">✖</button></li>`;
    $(el).append(item).find('.remove').on('click', function() {
      $(this).parents('li').remove();
      if ($(el).find('li').length == 0) { $(el).find('p').show(); }
    });
  }
}

$('#options').on('click', function() {
  $('#filter, #panel-options').fadeIn(250);
});

$('#basebri').on('change', function() {
  if ($(this).val() >= 254) { $('#briwarn').fadeIn(150) }
  else { $('#briwarn').fadeOut(150) }
  localStorage['basebri'] = $(this).val();
});

$('#overlay').on('change', function() {
  localStorage['overlay'] = $(this).prop('checked');
});

$('#theme').on('change', function() {
  localStorage['theme'] = $(this).val();

  if ($(this).val() == 'dark') {
    $(':root').css({
      '--background': '#303035',
      '--foreground1': '#3D3D43',
      '--foreground2': '#3D3D4390',
      '--border1': '#1D1D23',
      '--border2': '#3D3D43',
      '--indent': '#28282D',
      '--shadow1': '#16161B60',
      '--shadow2': '#16161B60',
      '--dark': '#B1B1B6',
      '--mid1': '#89898E',
      '--mid2': '#7C7C82',
      '--high': '#65656A',
    })
    $('input[type=checkbox]').css('filter', 'brightness(0.75)');
  }
  else {
    $(':root').css({
      '--background': '',
      '--foreground1': '',
      '--foreground2': '',
      '--border1': '',
      '--border2': '',
      '--indent': '',
      '--shadow1': '',
      '--shadow2': '',
      '--dark': '',
      '--mid1': '',
      '--mid2': '',
      '--high': '',
    })
    $('input[type=checkbox]').css('filter', '');
  }
});

$('#minify').on('change', function() {
  $('#groups, .group, #buttons, #gamestatus, #panel-events, #hubstatus, #defcols, #reset-prefs, #reset-hub').show();
  $('#lightbar').css({ 'min-height': '', 'max-height': '', 'overflow-y': '' });
  $('#group-grid').css({ 'grid-template': '', 'height': '' });
  $('.panel').css('padding', '');

  switch ($(this).val()) {
    default:
    case 'full':
      ipcRenderer.send('resize', 600, 490, 800, 490, 1000, 490);
      break;

    case 'half':
      ipcRenderer.send('resize', 350, 490, 400, 490, 600, 490);
      $('#panel-events').hide();
      break;

    case 'mini':
      ipcRenderer.send('resize', 350, 300, 400, 300, 600, 300);
      $('#panel-events, #hubstatus, #defcols, #group3, #group4, #reset-prefs, #reset-hub').hide();
      $('#group-grid').css({ 'grid-template': '1fr / 1fr 1fr', 'height': '80px' });
      break;

    case 'lightbar':
      ipcRenderer.send('resize', 350, 84, 400, 84, 800, 84);
      $('#groups, #buttons, #gamestatus, #panel-events, #hubstatus, #defcols, #reset-prefs, #reset-hub').hide();
      $('#filter, #panel-options').hide();
      $('#lightbar').css({ 'min-height': 'none', 'max-height': '64px', 'overflow-y': 'hidden' });
      $('.panel').css('padding', '8px');
      break;
  }
})

$('#reset-prefs').on('click', function() {
  let apiKey = localStorage['apiKey'];
  let clientKey = localStorage['clientKey'];
  let bridgeIp = localStorage['bridgeIp'];
  localStorage.clear();
  localStorage['apiKey'] = apiKey;
  localStorage['clientKey'] = clientKey;
  localStorage['bridgeIp'] = bridgeIp;
  location.reload();
});

var verify = false;
$('#reset-hub').on('click', function() {
  if (!verify) {
    verify = true;
    $(this).html('Are You Sure?');

    timer = window.setTimeout(function() {
      $("#reset-hub").html('Remove Bridge').off('click.verify');
      verify = false;
    }, 2000)

    $(this).on('click.verify', function() {
      $(this).off('click.verify').html('Resetting...');
      window.clearTimeout(timer);
      localStorage.removeItem('bridgeIp');
      localStorage.removeItem('apiKey');
      localStorage.removeItem('clientKey');
      location.reload();
    })
  }
});

$('#done').on('click', function() {
  $('#filter, #panel-options').fadeOut(250);
});

async function createEntertainmentArea() {
  var bridgeIp = localStorage['bridgeIp'];
  var apiKey = localStorage['apiKey'];

  var groups = await $.get(`http://${bridgeIp}/api/${apiKey}/groups `);

  for (key of Object.keys(groups)) {
    let group = groups[key];

    if (group['name'] == 'HueSaber') {
      await $.ajax({
        type: 'PUT',
        url: `http://${bridgeIp}/api/${apiKey}/groups/${key}`,
        data: JSON.stringify({ lights: Object.keys(lightState) }),
        dataType: 'json',
        success: function(response) {
          console.log(response);
          localStorage['lightGroup'] = key;
        }
      });
      return false;
    }
  }

  await $.ajax({
    type: 'POST',
    url: `http://${bridgeIp}/api/${apiKey}/groups`,
    data: JSON.stringify({
      name: 'HueSaber',
      type: 'Entertainment',
      class: 'TV',
      lights: Object.keys(lightState)
    }),
    dataType: 'json',
    success: function(response) {
      console.log(response);
      localStorage['lightGroup'] = response[0]['success']['id'];
    }
  });
}

var started = false;
var error = false;
function startWebSocket() {
  webSocket = new WebSocket('ws://localhost:6557/socket');

  webSocket.onopen = function() {
    console.log('Connected to Beat Saber');
    $('#gamestatus').html('Connected to Beat Saber');

    startUdpSocket();
  }

  webSocket.onclose = function() {
    closeSockets();
    if (!error) { $('#gamestatus').html('Not Connected') }
    $('#start').html('Start').prop('disabled', false);
    error = false;
  }

  webSocket.onerror = function() {
    $('#gamestatus').html('Failed to connect! Ensure <a href="https://github.com/opl-/beatsaber-http-status" target="_blank">http-status</a> is installed.');
    $('#start').html('Start').prop('disabled', false);
    started = false;
    error = true;
  }

  webSocket.onmessage = function(msg) {
    handleEvent(JSON.parse(msg.data));
  }
}

async function streamingMode(state) {
  var bridgeIp = localStorage['bridgeIp'];
  var apiKey = localStorage['apiKey'];

  $.ajax({
    type: 'PUT',
    url: `http://${bridgeIp}/api/${apiKey}/groups/${localStorage['lightGroup']}`,
    data: JSON.stringify({ stream: { active: state } }),
    dataType: 'json',
    success: function(response) { console.log(response) }
  });
}

async function startUdpSocket() {
  await createEntertainmentArea();
  await streamingMode(true);

  udpSocket = dtls.connect({
    type: 'udp4',
    remotePort: 2100,
    remoteAddress: localStorage['bridgeIp'],
    pskIdentity: localStorage['apiKey'],
    pskSecret: Buffer.from(localStorage['clientKey'], 'hex'),
    cipherSuites: ['TLS_PSK_WITH_AES_128_GCM_SHA256']
  })

  udpSocket.on('error', function(err) {
    console.error(err);
  });

  udpSocket.once('connect', function() {
    console.log('Connected to Hue Stream');
    $('#start').html('Stop').prop('disabled', false);
  });

  streamLoop = setInterval(function sendPacket() {
    let packet = compilePacket()
    udpSocket.write(packet);
  }, 20);
}

async function closeSockets() {
  console.log('Closing Connections...');
  if (webSocket) {
    await webSocket.close();
    webSocket = null;
    console.log('Disconnected from Beat Saber');
  }
  if (streamLoop) {
    clearInterval(streamLoop);
    streamloop = null;
  }
  if (udpSocket) {
    await udpSocket.close();
    await streamingMode(false);
    udpSocket = null;
    console.log('Disconnected from Hue Stream');
  }
  started = false;
}

$('#start').on('click', function() {
  if (started) {
    $('#gamestatus').html('Not Connected');
    $('#start').html('Start');
    closeSockets();
    started = false;
  }
  else {
    $(this).prop('disabled', true);
    $('#gamestatus').html('Connecting...');
    startWebSocket();
    started = true;
  }
});

$('#exit').on('click', async function() {
  await closeSockets();
  window.close();
});

ipcRenderer.on('close', closeSockets);

$('#reload').on('click', async function() {
  await closeSockets();
  location.reload();
  ipcRenderer.send('resize', 600, 490, 800, 490, 1000, 490);
});

function createEvent(id, name, speed = false, speedval = 0.3, color = false, colorval = '#FFFFFF', enabled = false) {
  var speedcheck = false;
  var colorcheck = false;
  var groups = '1234';

  if (localStorage[id] !== (null || undefined)) {
    [groups, speedcheck, speedval, colorcheck, colorval, enabled] = JSON.parse(localStorage[id]);
  }
  else { localStorage[id] = JSON.stringify([groups, speedcheck, speedval, colorcheck, colorval, enabled]) }

  if (speed) {
    speed = `<div class="item-option speed" style="margin-bottom: 5px;">
      <div>
        <input type="checkbox" ${speedcheck ? 'checked' : ''}>
        <span>Custom Speed</span>
      </div>
      <input type="number" min="0.1" max="1" step="0.1" value="${speedval}">
    </div>`;
  } else { speed = '' }

  if (color) {
    color = `<div class="item-option color">
      <div>
        <input type="checkbox" ${colorcheck ? 'checked' : ''}>
        <span>Custom Color</span>
      </div>
      <input type="color" value="${colorval}">
    </div>`;
  } else { color = '' }

  let listItem = `<li id="${id}" class="list-item" ${enabled ? '' : 'style="filter: opacity(0.75)"'}>
    <div class="subpanel item-header" style="${enabled ? 'border-radius: 10px 10px 0px 0px;' : 'border-radius: 10px;'}">
      <div>
        <input type="checkbox" ${enabled ? 'checked' : ''}>
        <span style="margin-right: 20px;">${name}</span>
      </div>
      <div>
        <span style="font-weight: 400;">Group:</span>
        <select value="${groups}" selected>
          <option value="1234">1-4</option>
          <option value="12">1-2</option>
          <option value="1">1</option>
          <option value="2">2</option>
          <option value="3">3</option>
          <option value="4">4</option>
        </select>
      </div>
    </div>

    <div class="item-body" ${enabled ? '' : 'style="display:none;"'}>
      ${speed}
      ${color}
    </div>
  </li>`;

  $('#eventlist').append(listItem);
  $(`#eventlist #${id} option:contains('${groups}')`).prop({ selected: true });
}

$('#eventlist').append('<p>Player Events</p>');
createEvent('slc', 'Note Slice', true, 0.4, false, '#FFFFFF', false);
createEvent('mss', 'Note Miss', true, 0.4, true, '#C81414', true);
createEvent('bmb', 'Bomb Hit', true, 0.6, true, '#C81414', true);
createEvent('wal', 'In Wall', false, null, true, '#C81414', true);
createEvent('fal', 'Fail', false, null, true, '#C81414', true);
$('#eventlist').append('<p>Map Events</p>');
createEvent('bgc', 'Center Lights');
createEvent('rng', 'Ring Lights');
createEvent('bla', 'Back Lasers');
createEvent('lla', 'Left Lasers');
createEvent('rla', 'Right Lasers');
// $('#eventlist').append('<p>Special Events</p>');
// createEvent('Cut Score', 'scr', true, 0.3, false, null, false);
// createEvent('Level Score', 'grd', false, null, false, null, false);

$('#defcols input').on('change', function() {
  let lcol = $('#lcol').val();
  let rcol = $('#rcol').val();
  localStorage['lcol'] = lcol;
  localStorage['rcol'] = rcol;
  $('#defcols').css('background-image',
    `radial-gradient(ellipse at 25% 80%,${lcol}80,transparent 50%),
   radial-gradient(ellipse at 75% 80%,${rcol}80,transparent 50%)`);
  console.log(`Base colors: %c${lcol} %c& %c${rcol}`, `color: ${lcol}`, 'color: inherit', `color: ${rcol}`);
});

$('.item-header input[type=checkbox]').on('change', function() {
  if ($(this).is(':checked')) {
    $(this).parents('.item-header').animate({ BorderBottomLeftRadius: '0px', BorderBottomRightRadius: '0px' }, 250);
    $(this).parents('.list-item').css('filter', 'none').find('.item-body').slideDown(250);
  }
  else {
    $(this).parents('.list-item').css('filter', 'opacity(0.75)').find('.item-body').slideUp(250);
    $(this).parents('.item-header').delay(250).animate({ BorderRadius: '10px' }, 250);
  }
});

$('.list-item select, .list-item input').on('change', function() {
  let main = $(this).parents('.list-item');

  // [groups, speedcheck, speedval, colorcheck, colorval, enabled]
  localStorage[main.attr('id')] = JSON.stringify(
    [
      main.find('select').val(),
      main.find('.speed input[type=checkbox]').prop('checked'),
      main.find('.speed input[type=number]').val(),
      main.find('.color input[type=checkbox]').prop('checked'),
      main.find('.color input[type=color]').val(),
      main.find('.item-header input').prop('checked')
    ]
  )
});

$('#filter, #panel-intro, #panel-bridge, #panel-options').hide();

async function initInterface() {
  localStorage['lcol'] === (null || undefined) ? localStorage['lcol'] = $('#lcol').val() : $('#lcol').val(localStorage['lcol']);
  localStorage['rcol'] === (null || undefined) ? localStorage['rcol'] = $('#rcol').val() : $('#rcol').val(localStorage['rcol']);
  $('#lcol').change();

  localStorage['basebri'] === (null || undefined) ? localStorage['basebri'] = $('#basebri').val() : $('#basebri').val(localStorage['basebri']);
  $('#basebri').change();

  localStorage['overlay'] === (null || undefined) ? localStorage['overlay'] = $('#overlay').prop('checked') : $('#overlay').prop('checked', JSON.parse(localStorage['overlay']));
  localStorage['theme'] === (null || undefined) ? localStorage['theme'] = $('#theme').val() : $('#theme').val(localStorage['theme']);
  $('#theme').change();

  var bridgeIp = localStorage['bridgeIp'];
  var apiKey = localStorage['apiKey'];
  var bridgeConfig = await $.get(`http://${bridgeIp}/api/${apiKey}/config`);
  $('#hubstatus').html(`Connected to Bridge: ${bridgeConfig['name']}`);

  var lights = await $.get(`http://${bridgeIp}/api/${apiKey}/lights`);
  localStorage['lights'] = JSON.stringify(lights);

  Object.keys(lights).forEach(function(key) {
    let light = lights[key];

    let arch = light['config']['archetype'];
    let active = light['state']['reachable'];
    let xy = light['state']['xy'] || [0, 0];
    let bri = light['state']['bri'];

    lightState[key] = { active: active, x: xy[0], y: xy[1], bri: bri, x2: 0, y2: 0, bri2: 0, boost: 0 };
    defState[key] = { x: xy[0], y: xy[1], bri: bri };

    let icon = `<div id="${key}" class="light-icon" draggable="true" ondragstart="drag(event)" ${active ? '' : 'style="color:#9AA1B1;" title="Not Reachable"'}>
      <svg viewBox="2 2 21 21" xmlns="http://www.w3.org/2000/svg" title="${light['productname']}" ${active ? '' : 'style="fill:#9AA1B1;"'}>
        <path d="${lightIcon(arch)}"/>
      </svg>
      <span>${light['name']}</span>
    </div>`;

    $('#lightbar p').hide();
    $('#lightbar').append(icon);
  })

  // for (let i = 5; i < 21; i++) {
  //   lightState[i] = { active: true, x: 0, y: 0, bri: 254, x2: 0, y2: 0, bri2: 0, boost: 0 };
  //   let icon = `<div id="${i}" class="light-icon" draggable="true" ondragstart="drag(event)"}>
  //     <svg viewBox="2 2 21 21" xmlns="http://www.w3.org/2000/svg">
  //       <path d="${lightIcon('classic')}"/>
  //     </svg>
  //     <span>Light${i}</span>
  //   </div>`;
  //   $('#lightbar').append(icon);
  // }
}

async function authorizeBridge(bridgeIp) {
  $('#panel-bridge').fadeOut(250);
  $('#panel-intro').fadeIn(750);

  localStorage['bridgeIp'] = bridgeIp;
  console.log(`Bridge found at ${bridgeIp}, waiting for button...`);

  var request = async function() {
    userid = await $.post(`http://${bridgeIp}/api`, JSON.stringify({ "devicetype": "HueSaber#Electron", "generateclientkey": true }), dataType = 'json');

    if ('success' in userid[0]) {
      window.clearInterval(loop);
      localStorage['apiKey'] = userid[0]['success']['username'];
      localStorage['clientKey'] = userid[0]['success']['clientkey'];

      console.log('Button pressed!');
      initInterface();
      $('#filter, #panel-intro').fadeOut(500);
    }
  }
  var loop = window.setInterval(request, 4000);
}

if (localStorage['apiKey'] === (null || undefined)) {
  $('#filter').fadeIn(750);

  $.get('https://discovery.meethue.com/', function(query) {
    if (query != []) {

      if (query.length > 1) {
        query.forEach(async function(i) {
          let ip = i['internalipaddress'];
          let info = await $.get(`http://${ip}/api/config`);

          let button = `<button class="subpanel" onclick="authorizeBridge('${ip}')">
            <span>${info['name']}</span>
            <span>(${ip})</span>
          </button>`

          $('#panel-bridge div').prepend(button);
        })
        $('#panel-bridge').fadeIn(500);
      }

      else {
        authorizeBridge(query[0]['internalipaddress']);
      }
    }

    else {
      console.log('No bridge found!');
      $('#intro-main').html('Unfortunately, no bridge was detected.<br>Ensure it is active and on the same network.');
      $('#intro-sub').html('Reload or restart this application to try again.');
      $('panel-intro').fadeIn(750);
    }
  });
}
else { initInterface() }
