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
    this.config = config;
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
      if (!deviceConfig.ip || !deviceConfig.token || !deviceConfig.name || !deviceConfig.type) {
        this.log.warn('A device in your configuration is missing ip, token, name, or type. Skipping.');
        continue;
      }
      const supportedModels = ['MiAirPurifier2S', 'MiAirPurifierPro'];
      if (!supportedModels.includes(deviceConfig.type)) {
        this.log.warn(`Device type '${deviceConfig.type}' is not supported by this plugin. Skipping.`);
        continue;
      }

      const uuid = UUIDGen.generate(deviceConfig.ip);
      const existingAccessory = this.accessories.find(acc => acc.UUID === uuid);

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
    
    const accessoriesToUnregister = this.accessories.filter(acc => !foundAccessories.has(acc.UUID));
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
    this.config = accessory.context.device;
    this.device = null;
    this.state = {}; // Cached device state
    this.pollInterval = null;

    this.maxFavoriteLevel = this.config.type === 'MiAirPurifier2S' ? 14 : 16;

    // Air Quality thresholds (validate or use default)
    this.aqThresholds = this.parseAqThresholds(this.config.airQualityThresholds);

    this.setupServices();
    this.connect();
  }

  parseAqThresholds(arr) {
    const def = [5, 15, 35, 55];
    if (!Array.isArray(arr) || arr.length !== 4) return def;
    const nums = arr.map(v => Number(v)).filter(v => Number.isFinite(v) && v >= 0);
    if (nums.length !== 4) return def;
    for (let i = 1; i < nums.length; i++) {
      if (nums[i] < nums[i - 1]) return def;
    }
    return nums;
  }

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

  updateAllCharacteristics() {
    // Air Purifier Service
    const airPurifierService = this.accessory.getService(Service.AirPurifier);
    if (airPurifierService) {
      airPurifierService.updateCharacteristic(Characteristic.Active, this.state.power === 'on' ? 1 : 0);
      airPurifierService.updateCharacteristic(Characteristic.CurrentAirPurifierState, this.state.power === 'on' ? 2 : 0);
      
      let targetState = Characteristic.TargetAirPurifierState.AUTO;
      if (this.state.mode === 'favorite' || this.state.mode === 'silent') {
        targetState = Characteristic.TargetAirPurifierState.MANUAL;
      }
      airPurifierService.updateCharacteristic(Characteristic.TargetAirPurifierState, targetState);
      
      const speed = Math.round((this.state.favorite_level / this.maxFavoriteLevel) * 100);
      airPurifierService.updateCharacteristic(Characteristic.RotationSpeed, speed);
      airPurifierService.updateCharacteristic(Characteristic.FilterLifeLevel, this.state.filter1_life);
      airPurifierService.updateCharacteristic(Characteristic.FilterChangeIndication, this.state.filter1_life < 5 ? 1 : 0);
    }

    // Sensor Services (via fixed subType IDs)
    const tempVal = Number(this.state.temp_dec) / 10;
    this.updateSensor(Service.TemperatureSensor, 'Temperature', Characteristic.CurrentTemperature, Number.isFinite(tempVal) ? tempVal : 0);
    const humVal = Number(this.state.humidity);
    this.updateSensor(Service.HumiditySensor, 'Humidity', Characteristic.CurrentRelativeHumidity, Number.isFinite(humVal) ? humVal : 0);

    const aqService = this.accessory.getServiceById(Service.AirQualitySensor, 'AirQuality');
    if (aqService) {
      const aqi = Number(this.state.aqi);
      const level = this.mapAqiToHomeKitLevel(aqi, this.aqThresholds);
      aqService.updateCharacteristic(Characteristic.AirQuality, level);
      if (Number.isFinite(aqi)) {
        aqService.updateCharacteristic(Characteristic.PM2_5Density, aqi);
      }
    }
    
    // Switch Services (via fixed subType IDs)
    this.updateSwitchById('LED', this.state.led === 'on');
    this.updateSwitchById('Buzzer', this.state.buzzer === 'on');
    this.updateSwitchById('AutoMode', this.state.mode === 'auto');
    this.updateSwitchById('SleepMode', this.state.mode === 'silent');
    this.updateSwitchById('FavoriteMode', this.state.mode === 'favorite');
  }
  
  updateSensor(serviceType, subType, characteristic, value) {
    const service = this.accessory.getServiceById(serviceType, subType);
    if (service) {
      service.updateCharacteristic(characteristic, value);
    }
  }
  
  updateSwitchById(subType, isOn) {
    const service = this.accessory.getServiceById(Service.Switch, subType);
    if (service) {
      service.updateCharacteristic(Characteristic.On, isOn);
    }
  }

  mapAqiToHomeKitLevel(aqi, t) {
    if (!Number.isFinite(aqi)) return Characteristic.AirQuality.UNKNOWN; // 0
    if (aqi <= t[0]) return Characteristic.AirQuality.EXCELLENT; // 1
    if (aqi <= t[1]) return Characteristic.AirQuality.GOOD;      // 2
    if (aqi <= t[2]) return Characteristic.AirQuality.FAIR;      // 3
    if (aqi <= t[3]) return Characteristic.AirQuality.INFERIOR;  // 4
    return Characteristic.AirQuality.POOR;                        // 5
  }

  async setPropertyValue(method, value) {
    if (!this.device) throw new Error('Device not connected');
    try {
      const result = await this.device.call(method, value);
      if (result[0] !== 'ok') throw new Error(`Device returned an error: ${result[0]}`);
      setTimeout(() => this.pollDeviceState(), 250);
    } catch (e) {
      this.log.error(`Error setting property with method '${method}' on ${this.config.name}: ${e.message}`);
      this.connect();
      throw e;
    }
  }

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
    } else {
      if (svc) this.accessory.removeService(svc);
    }
  }

  setupAccessoryInfo() {
    this.accessory.getService(Service.AccessoryInformation)
      .setCharacteristic(Characteristic.Manufacturer, 'Xiaomi')
      .setCharacteristic(Characteristic.Model, this.config.type)
      .setCharacteristic(Characteristic.SerialNumber, this.config.ip);
  }

  setupAirPurifier() {
    const service = this.accessory.getService(Service.AirPurifier) || this.accessory.addService(Service.AirPurifier, this.config.name);
    service.getCharacteristic(Characteristic.Active).onSet(async v => this.setPropertyValue('set_power', [v ? 'on' : 'off']));
    service.getCharacteristic(Characteristic.TargetAirPurifierState).onSet(async v => this.setPropertyValue('set_mode', [v === 0 ? 'auto' : 'favorite']));
    service.getCharacteristic(Characteristic.RotationSpeed).onSet(async v => this.setPropertyValue('set_favorite_level', [Math.round((v / 100) * this.maxFavoriteLevel)]));
  }

  // Sensors (display names customizable, fixed subType IDs)
  setupAirQualitySensor() {
    const name = this.config.airQualityName || `${this.config.name} Air Quality`;
    this.accessory.addService(Service.AirQualitySensor, name, 'AirQuality');
  }
  setupTemperatureSensor() {
    const name = this.config.temperatureName || `${this.config.name} Temperature`;
    this.accessory.addService(Service.TemperatureSensor, name, 'Temperature');
  }
  setupHumiditySensor() {
    const name = this.config.humidityName || `${this.config.name} Humidity`;
    this.accessory.addService(Service.HumiditySensor, name, 'Humidity');
  }

  // Switches (display names customizable, fixed subType IDs)
  setupLedSwitch() {
    const name = this.config.ledName || `${this.config.name} LED`;
    const service = this.accessory.addService(Service.Switch, name, 'LED');
    service.getCharacteristic(Characteristic.On).onSet(async v => {
      if (this.config.type === 'MiAirPurifierPro') await this.setPropertyValue('set_led_b', [v ? 0 : 2]);
      else await this.setPropertyValue('set_led', [v ? 'on' : 'off']);
    });
  }

  setupBuzzerSwitch() {
    const name = this.config.buzzerName || `${this.config.name} Buzzer`;
    const service = this.accessory.addService(Service.Switch, name, 'Buzzer');
    service.getCharacteristic(Characteristic.On).onSet(async v => this.setPropertyValue('set_buzzer', [v ? 'on' : 'off']));
  }

  setupModeSwitch(subType, displayName, modeValue) {
    const service = this.accessory.addService(Service.Switch, displayName, subType);
    service.getCharacteristic(Characteristic.On).onSet(async value => {
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
}
