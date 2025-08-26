// index.js
const miio = require('miio');
const packageJson = require('./package.json');

let PlatformAccessory, Service, Characteristic, UUIDGen;

const PLATFORM_NAME = 'XiaomiAirPurifierPlatform';
const PLUGIN_NAME = '@km81/homebridge-xiaomi-airpurifier';
const POLLING_INTERVAL = 15000; // 15 seconds

module.exports = (api) => {
  PlatformAccessory = api.platformAccessory;
  Service = api.hap.Service;
  Characteristic = api.hap.Characteristic;
  UUIDGen = api.hap.uuid;
  api.registerPlatform(PLATFORM_NAME, XiaomiAirPurifierPlatform);
};

class XiaomiAirPurifierPlatform {
  constructor(log, config, api) {
    this.log = log;
    this.config = config || {};
    this.api = api;
    this.accessories = [];
    this.log.info(`Initializing Xiaomi Air Purifier platform v${packageJson.version}`);
    this.api.on('didFinishLaunching', () => this.discoverDevices());
  }

  configureAccessory(accessory) {
    this.log.info(`Loading accessory from cache: ${accessory.displayName}`);
    this.accessories.push(accessory);
  }

  discoverDevices() {
    const configuredDevices = this.config.deviceCfgs || [];
    const foundAccessories = new Set();

    for (const deviceConfig of configuredDevices) {
      if (!deviceConfig || !deviceConfig.ip || !deviceConfig.token || !deviceConfig.name || !deviceConfig.type) {
        this.log.warn('A device in your configuration is missing ip, token, name, or type. Skipping.');
        continue;
      }

      const supportedModels = ['MiAirPurifier2S', 'MiAirPurifierPro'];
      if (!supportedModels.includes(deviceConfig.type)) {
        this.log.warn(`Device type '${deviceConfig.type}' is not supported by this plugin. Skipping.`);
        continue;
      }

      const uuid = UUIDGen.generate(deviceConfig.ip);
      const existingAccessory = this.accessories.find((acc) => acc.UUID === uuid);

      if (existingAccessory) {
        this.log.info(`Restoring existing accessory: ${existingAccessory.displayName}`);
        existingAccessory.context.device = deviceConfig;
        new DeviceHandler(this, existingAccessory);
        foundAccessories.add(existingAccessory.UUID);
      } else {
        this.log.info(`Adding new accessory: ${deviceConfig.name}`);
        const accessory = new PlatformAccessory(deviceConfig.name, uuid);
        accessory.context.device = deviceConfig;
        new DeviceHandler(this, accessory);
        this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
        foundAccessories.add(accessory.UUID);
      }
    }

    const accessoriesToUnregister = this.accessories.filter((acc) => !foundAccessories.has(acc.UUID));
    if (accessoriesToUnregister.length > 0) {
      this.log.info(`Unregistering ${accessoriesToUnregister.length} stale accessories.`);
      this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, accessoriesToUnregister);
    }
  }
}

class DeviceHandler {
  constructor(platform, accessory) {
    this.platform = platform;
    this.log = platform.log;
    this.accessory = accessory;
    this.config = accessory.context.device || {};
    this.device = null;
    this.state = {}; // Cached device state
    this.pollInterval = null;

    this.maxFavoriteLevel = this.config.type === 'MiAirPurifier2S' ? 14 : 16;

    // Air Quality thresholds (validate or use default)
    this.aqThresholds = this.parseAqThresholds(this.config.airQualityThresholds);

    this.setupServices();
    this.connect();
  }

  // -------- Helpers --------
  parseAqThresholds(conf) {
    const def = [5, 15, 35, 55];

    // object 형태 {t1,t2,t3,t4}
    if (conf && typeof conf === 'object' && !Array.isArray(conf)) {
      const cand = [conf.t1, conf.t2, conf.t3, conf.t4].map((v) => Number(v));
      if (cand.every((v) => Number.isFinite(v) && v >= 0)) {
        if (cand[0] <= cand[1] && cand[1] <= cand[2] && cand[2] <= cand[3]) return cand;
      }
    }

    // array 형태 [n1,n2,n3,n4]
    if (Array.isArray(conf) && conf.length === 4) {
      const cand = conf.map((v) => Number(v));
      if (cand.every((v) => Number.isFinite(v) && v >= 0)) {
        if (cand[0] <= cand[1] && cand[1] <= cand[2] && cand[2] <= cand[3]) return cand;
      }
    }

    return def;
  }

  mapAqiToHomeKitLevel(aqi, t) {
    if (!Number.isFinite(aqi)) return Characteristic.AirQuality.UNKNOWN; // 0
    if (aqi <= t[0]) return Characteristic.AirQuality.EXCELLENT; // 1
    if (aqi <= t[1]) return Characteristic.AirQuality.GOOD;      // 2
    if (aqi <= t[2]) return Characteristic.AirQuality.FAIR;      // 3
    if (aqi <= t[3]) return Characteristic.AirQuality.INFERIOR;  // 4
    return Characteristic.AirQuality.POOR;                        // 5
  }

  setServiceName(service, name) {
    try { service.updateCharacteristic(Characteristic.Name, name); } catch (_) {}
    try { if (Characteristic.ConfiguredName) service.updateCharacteristic(Characteristic.ConfiguredName, name); } catch (_) {}
  }

  isMethodNotFound(err) {
    return err && typeof err.message === 'string' && /method not found/i.test(err.message);
  }

  // -------- Device I/O --------
  async connect() {
    try {
      this.log.info(`Connecting to ${this.config.name} at ${this.config.ip}...`);
      this.device = await miio.device({ address: this.config.ip, token: this.config.token });
      this.log.info(`Successfully connected to ${this.config.name}.`);

      clearInterval(this.pollInterval);
      this.pollDeviceState(); // Poll immediately
      this.pollInterval = setInterval(() => this.pollDeviceState(), POLLING_INTERVAL);
    } catch (e) {
      this.log.error(`Failed to connect to ${this.config.name}. Retrying in 30 seconds. Error: ${e.message}`);
      setTimeout(() => this.connect(), 30000);
    }
  }

  async pollDeviceState() {
    if (!this.device) return;
    try {
      const props = [
        'power', 'mode', 'aqi', 'temp_dec',
        'humidity', 'filter1_life', 'favorite_level', 'led', 'buzzer'
      ];
      const values = await this.device.call('get_prop', props);

      props.forEach((prop, i) => {
        this.state[prop] = values[i];
      });

      this.updateAllCharacteristics();
    } catch (e) {
      this.log.error(`Failed to poll ${this.config.name}: ${e.message}`);
    }
  }

  async setPropertyValue(method, value) {
    if (!this.device) throw new Error('Device not connected');
    try {
      const result = await this.device.call(method, value);
      if (!Array.isArray(result) || result[0] !== 'ok') {
        throw new Error(`Device returned an error: ${Array.isArray(result) ? result[0] : String(result)}`);
      }
      setTimeout(() => this.pollDeviceState(), 250);
    } catch (e) {
      // "Method not found"는 연결 문제 아님: 재연결 금지
      if (this.isMethodNotFound(e)) {
        this.log.warn(`Method '${method}' not supported by ${this.config.name}.`);
      } else {
        this.log.error(`Error setting property with method '${method}' on ${this.config.name}: ${e.message}`);
        // 네트워크/세션 문제일 수 있으니 재연결
        this.connect();
      }
      throw e;
    }
  }

  // 메인: 회전속도(즐겨찾기 레벨) 설정 — 다양한 RPC 이름 폴백
  async setFavoriteLevelPercent(percent) {
    const level = Math.max(0, Math.min(100, Number(percent)));
    const target = Math.max(1, Math.min(this.maxFavoriteLevel, Math.round((level / 100) * this.maxFavoriteLevel)));

    // 1) 모드를 favorite으로 (일부 기기는 favorite 상태에서만 레벨 반영)
    try {
      if (this.state.mode !== 'favorite') {
        await this.setPropertyValue('set_mode', ['favorite']);
      }
    } catch (e) {
      // 모드 전환 실패해도 계속 진행(몇몇 펌웨어는 자동으로 수용)
      if (!this.isMethodNotFound(e)) this.log.warn(`Failed to switch to 'favorite' before setting level: ${e.message}`);
    }

    // 2) 다양한 메서드 순차 시도
    const tries = [
      ['set_favorite_level', [target]],
      ['set_level_favorite', [target]],
      ['set_favorite', [target]],
      ['set_speed_level', [target]],
      ['set_level', [target]],
    ];

    let lastErr = null;
    for (const [m, args] of tries) {
      try {
        await this.setPropertyValue(m, args);
        this.log.info(`Set favorite level via '${m}' → ${target}/${this.maxFavoriteLevel} (${level}%).`);
        return;
      } catch (e) {
        lastErr = e;
        // Method not found 이면 다음 후보로, 그 외 오류도 다음 후보로 폴백
        continue;
      }
    }

    // 모두 실패
    const methods = tries.map(([m]) => m).join(', ');
    this.log.warn(`None of methods supported for favorite level on ${this.config.name}. Tried: ${methods}`);
    if (lastErr) this.log.warn(`Last error: ${lastErr.message}`);
  }

  // -------- Services: create/update --------
  setupServices() {
    this.setupAccessoryInfo();
    this.setupAirPurifier();

    this.setupOrRemoveService(this.config.showTemperature !== false, Service.TemperatureSensor, 'Temperature', () => this.setupTemperatureSensor());
    this.setupOrRemoveService(this.config.showHumidity !== false, Service.HumiditySensor, 'Humidity', () => this.setupHumiditySensor());
    this.setupOrRemoveService(this.config.showAirQuality !== false, Service.AirQualitySensor, 'AirQuality', () => this.setupAirQualitySensor());

    this.setupOrRemoveService(this.config.showLED === true, Service.Switch, 'LED', () => this.setupLedSwitch());
    this.setupOrRemoveService(this.config.showBuzzer === true, Service.Switch, 'Buzzer', () => this.setupBuzzerSwitch());

    this.setupOrRemoveService(this.config.showAutoModeSwitch === true, Service.Switch, 'AutoMode', () => this.setupModeSwitch('AutoMode', this.config.autoModeName || `${this.config.name} Auto Mode`, 'auto'));
    this.setupOrRemoveService(this.config.showSleepModeSwitch === true, Service.Switch, 'SleepMode', () => this.setupModeSwitch('SleepMode', this.config.sleepModeName || `${this.config.name} Sleep Mode`, 'silent'));
    this.setupOrRemoveService(this.config.showFavoriteModeSwitch === true, Service.Switch, 'FavoriteMode', () => this.setupModeSwitch('FavoriteMode', this.config.favoriteModeName || `${this.config.name} Favorite Mode`, 'favorite'));
  }

  setupOrRemoveService(condition, serviceType, subType, setupFn) {
    const svc = this.accessory.getServiceById(serviceType, subType);
    if (condition) {
      if (!svc) setupFn();
      else {
        const currentName =
          (subType === 'AirQuality' && (this.config.airQualityName || `${this.config.name} Air Quality`)) ||
          (subType === 'Temperature' && (this.config.temperatureName || `${this.config.name} Temperature`)) ||
          (subType === 'Humidity' && (this.config.humidityName || `${this.config.name} Humidity`)) ||
          (subType === 'LED' && (this.config.ledName || `${this.config.name} LED`)) ||
          (subType === 'Buzzer' && (this.config.buzzerName || `${this.config.name} Buzzer`)) ||
          (subType === 'AutoMode' && (this.config.autoModeName || `${this.config.name} Auto Mode`)) ||
          (subType === 'SleepMode' && (this.config.sleepModeName || `${this.config.name} Sleep Mode`)) ||
          (subType === 'FavoriteMode' && (this.config.favoriteModeName || `${this.config.name} Favorite Mode`)) ||
          null;
        if (currentName) this.setServiceName(svc, currentName);
      }
    } else {
      if (svc) this.accessory.removeService(svc);
    }
  }

  setupAccessoryInfo() {
    this.accessory
      .getService(Service.AccessoryInformation)
      .setCharacteristic(Characteristic.Manufacturer, 'Xiaomi')
      .setCharacteristic(Characteristic.Model, this.config.type || 'Unknown')
      .setCharacteristic(Characteristic.SerialNumber, this.config.ip || 'Unknown');
  }

  setupAirPurifier() {
    const service =
      this.accessory.getService(Service.AirPurifier) ||
      this.accessory.addService(Service.AirPurifier, this.config.name);
    this.setServiceName(service, this.config.name);

    service.getCharacteristic(Characteristic.Active)
      .onSet(async (v) => this.setPropertyValue('set_power', [v ? 'on' : 'off']));

    service.getCharacteristic(Characteristic.TargetAirPurifierState)
      .onSet(async (v) => this.setPropertyValue('set_mode', [v === 0 ? 'auto' : 'favorite']));

    // ★ 여기만 변경: 회전속도 → 폴백 로직 사용
    service.getCharacteristic(Characteristic.RotationSpeed)
      .onSet(async (v) => this.setFavoriteLevelPercent(Number(v)));
  }

  // ---- Sensors (display names customizable, fixed subType IDs) ----
  setupAirQualitySensor() {
    const name = this.config.airQualityName || `${this.config.name} Air Quality`;
    const service = this.accessory.addService(Service.AirQualitySensor, name, 'AirQuality');
    this.setServiceName(service, name);
  }

  setupTemperatureSensor() {
    const name = this.config.temperatureName || `${this.config.name} Temperature`;
    const service = this.accessory.addService(Service.TemperatureSensor, name, 'Temperature');
    this.setServiceName(service, name);
  }

  setupHumiditySensor() {
    const name = this.config.humidityName || `${this.config.name} Humidity`;
    const service = this.accessory.addService(Service.HumiditySensor, name, 'Humidity');
    this.setServiceName(service, name);
  }

  // ---- Switches (display names customizable, fixed subType IDs) ----
  setupLedSwitch() {
    const name = this.config.ledName || `${this.config.name} LED`;
    const service = this.accessory.addService(Service.Switch, name, 'LED');
    this.setServiceName(service, name);
    service.getCharacteristic(Characteristic.On).onSet(async (v) => {
      if (this.config.type === 'MiAirPurifierPro') await this.setPropertyValue('set_led_b', [v ? 0 : 2]);
      else await this.setPropertyValue('set_led', [v ? 'on' : 'off']);
    });
  }

  setupBuzzerSwitch() {
    const name = this.config.buzzerName || `${this.config.name} Buzzer`;
    const service = this.accessory.addService(Service.Switch, name, 'Buzzer');
    this.setServiceName(service, name);
    service.getCharacteristic(Characteristic.On).onSet(async (v) => {
      await this.setPropertyValue('set_buzzer', [v ? 'on' : 'off']);
    });
  }

  setupModeSwitch(subType, displayName, modeValue) {
    const service = this.accessory.addService(Service.Switch, displayName, subType);
    this.setServiceName(service, displayName);
    service.getCharacteristic(Characteristic.On).onSet(async (value) => {
      if (value) {
        this.log.info(`Activating ${subType} for ${this.config.name}`);
        await this.setPropertyValue('set_mode', [modeValue]);
      } else {
        if (this.state.mode === modeValue) {
          this.log.info(`Deactivating ${subType}, reverting to Auto for ${this.config.name}`);
          await this.setPropertyValue('set_mode', ['auto']);
        }
      }
    });
  }

  // -------- Periodic updates --------
  updateAllCharacteristics() {
    // Air Purifier
    const svcAp = this.accessory.getService(Service.AirPurifier);
    if (svcAp) {
      const powerOn = this.state.power === 'on';
      svcAp.updateCharacteristic(Characteristic.Active, powerOn ? 1 : 0);
      svcAp.updateCharacteristic(
        Characteristic.CurrentAirPurifierState,
        powerOn ? Characteristic.CurrentAirPurifierState.PURIFYING_AIR : Characteristic.CurrentAirPurifierState.INACTIVE,
      );

      let targetState = Characteristic.TargetAirPurifierState.AUTO;
      if (this.state.mode === 'favorite' || this.state.mode === 'silent') {
        targetState = Characteristic.TargetAirPurifierState.MANUAL;
      }
      svcAp.updateCharacteristic(Characteristic.TargetAirPurifierState, targetState);

      const fav = Number(this.state.favorite_level);
      const speed = Number.isFinite(fav) ? Math.max(0, Math.min(100, Math.round((fav / this.maxFavoriteLevel) * 100))) : 0;
      svcAp.updateCharacteristic(Characteristic.RotationSpeed, speed);

      const life = Number(this.state.filter1_life);
      if (Number.isFinite(life)) {
        svcAp.updateCharacteristic(Characteristic.FilterLifeLevel, life);
        svcAp.updateCharacteristic(Characteristic.FilterChangeIndication, life < 5 ? 1 : 0);
      }
    }

    // Sensors
    const tSvc = this.accessory.getServiceById(Service.TemperatureSensor, 'Temperature');
    if (tSvc) {
      const temp = Number(this.state.temp_dec);
      const tempC = Number.isFinite(temp) ? temp / 10 : 0;
      tSvc.updateCharacteristic(Characteristic.CurrentTemperature, tempC);
    }

    const hSvc = this.accessory.getServiceById(Service.HumiditySensor, 'Humidity');
    if (hSvc) {
      const hum = Number(this.state.humidity);
      hSvc.updateCharacteristic(Characteristic.CurrentRelativeHumidity, Number.isFinite(hum) ? hum : 0);
    }

    const aqSvc = this.accessory.getServiceById(Service.AirQualitySensor, 'AirQuality');
    if (aqSvc) {
      const aqi = Number(this.state.aqi);
      const level = this.mapAqiToHomeKitLevel(aqi, this.aqThresholds);
      aqSvc.updateCharacteristic(Characteristic.AirQuality, level);
      if (Number.isFinite(aqi)) {
        aqSvc.updateCharacteristic(Characteristic.PM2_5Density, aqi);
      }
    }

    // Switches
    const ledSvc = this.accessory.getServiceById(Service.Switch, 'LED');
    if (ledSvc) ledSvc.updateCharacteristic(Characteristic.On, this.state.led === 'on');

    const buzSvc = this.accessory.getServiceById(Service.Switch, 'Buzzer');
    if (buzSvc) buzSvc.updateCharacteristic(Characteristic.On, this.state.buzzer === 'on');

    const autoSvc = this.accessory.getServiceById(Service.Switch, 'AutoMode');
    if (autoSvc) autoSvc.updateCharacteristic(Characteristic.On, this.state.mode === 'auto');

    const sleepSvc = this.accessory.getServiceById(Service.Switch, 'SleepMode');
    if (sleepSvc) sleepSvc.updateCharacteristic(Characteristic.On, this.state.mode === 'silent');

    const favSvc = this.accessory.getServiceById(Service.Switch, 'FavoriteMode');
    if (favSvc) favSvc.updateCharacteristic(Characteristic.On, this.state.mode === 'favorite');
  }
}
