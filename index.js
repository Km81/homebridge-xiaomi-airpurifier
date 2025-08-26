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

    this.setupServices();
    this.connect();
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
    if(airPurifierService) {
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

    // Sensor Services
    this.updateSensor(Service.TemperatureSensor, 'Temperature', Characteristic.CurrentTemperature, this.state.temp_dec / 10);
    this.updateSensor(Service.HumiditySensor, 'Humidity', Characteristic.CurrentRelativeHumidity, this.state.humidity);
    if(this.accessory.getServiceById(Service.AirQualitySensor, 'AirQuality')) {
        let airQuality = 0;
        if (this.state.aqi <= 35) airQuality = 1; else if (this.state.aqi <= 75) airQuality = 2; else if (this.state.aqi <= 115) airQuality = 3; else if (this.state.aqi <= 150) airQuality = 4; else airQuality = 5;
        this.accessory.getServiceById(Service.AirQualitySensor, 'AirQuality').updateCharacteristic(Characteristic.AirQuality, airQuality);
        this.accessory.getServiceById(Service.AirQualitySensor, 'AirQuality').updateCharacteristic(Characteristic.PM2_5Density, this.state.aqi);
    }
    
    // Switch Services
    this.updateSwitch('LED', this.state.led === 'on');
    this.updateSwitch('Buzzer', this.state.buzzer === 'on');
    this.updateSwitch('Auto Mode', this.state.mode === 'auto');
    this.updateSwitch('Sleep Mode', this.state.mode === 'silent');
    this.updateSwitch('Favorite Mode', this.state.mode === 'favorite');
  }
  
  updateSensor(serviceType, subType, characteristic, value) {
      const name = this.config[`${subType.toLowerCase()}Name`] || `${this.config.name} ${subType}`;
      const service = this.accessory.getService(name);
      if (service) {
          service.updateCharacteristic(characteristic, value);
      }
  }
  
  updateSwitch(name, isOn) {
      const serviceName = `${this.config.name} ${name}`;
      const service = this.accessory.getService(serviceName);
      if(service) {
          service.updateCharacteristic(Characteristic.On, isOn);
      }
  }

  async setPropertyValue(method, value) {
    if (!this.device) throw new Error('Device not connected');
    try {
      const result = await this.device.call(method, value);
      if (result[0] !== 'ok') throw new Error(`Device returned an error: ${result[0]}`);
      // After setting a property, poll immediately for instant feedback
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
    this.setupOrRemoveService(this.config.showTemperature !== false, Service.TemperatureSensor, 'Temperature', this.setupTemperatureSensor);
    this.setupOrRemoveService(this.config.showHumidity !== false, Service.HumiditySensor, 'Humidity', this.setupHumiditySensor);
    this.setupOrRemoveService(this.config.showAirQuality !== false, Service.AirQualitySensor, 'AirQuality', this.setupAirQualitySensor);
    this.setupOrRemoveService(this.config.showLED === true, Service.Switch, 'LED', this.setupLedSwitch);
    this.setupOrRemoveService(this.config.showBuzzer === true, Service.Switch, 'Buzzer', this.setupBuzzerSwitch);
    this.setupOrRemoveService(this.config.showAutoModeSwitch === true, Service.Switch, 'Auto Mode', () => this.setupModeSwitch('Auto', 'auto'));
    this.setupOrRemoveService(this.config.showSleepModeSwitch === true, Service.Switch, 'Sleep Mode', () => this.setupModeSwitch('Sleep', 'silent'));
    this.setupOrRemoveService(this.config.showFavoriteModeSwitch === true, Service.Switch, 'Favorite Mode', () => this.setupModeSwitch('Favorite', 'favorite'));
  }
  
  setupOrRemoveService(condition, serviceType, subType, setupFunction) {
      const name = `${this.config.name} ${subType}`;
      const service = this.accessory.getService(name);

      if (condition) {
          if (!service) {
              setupFunction.bind(this)();
          }
      } else {
          if (service) {
              this.accessory.removeService(service);
          }
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
  
  setupLedSwitch() {
    const name = `${this.config.name} LED`;
    const service = this.accessory.addService(Service.Switch, name, 'LED');
    service.getCharacteristic(Characteristic.On).onSet(async v => {
        if (this.config.type === 'MiAirPurifierPro') await this.setPropertyValue('set_led_b', [v ? 0 : 2]);
        else await this.setPropertyValue('set_led', [v ? 'on' : 'off']);
    });
  }
  
  setupBuzzerSwitch() {
    const name = `${this.config.name} Buzzer`;
    const service = this.accessory.addService(Service.Switch, name, 'Buzzer');
    service.getCharacteristic(Characteristic.On).onSet(async v => this.setPropertyValue('set_buzzer', [v ? 'on' : 'off']));
  }
  
  setupModeSwitch(name, modeValue) {
    const serviceName = `${this.config.name} ${name} Mode`;
    const service = this.accessory.addService(Service.Switch, serviceName, `${name} Mode`);
    service.getCharacteristic(Characteristic.On).onSet(async value => {
        if(value) {
            this.log.info(`Activating ${name} mode for ${this.config.name}`);
            await this.setPropertyValue('set_mode', [modeValue]);
        } else {
            // If user turns a mode switch OFF, revert to Auto mode.
            if(this.state.mode === modeValue) {
                this.log.info(`Deactivating ${name} mode, reverting to Auto for ${this.config.name}`);
                await this.setPropertyValue('set_mode', ['auto']);
            }
        }
    });
  }
}
