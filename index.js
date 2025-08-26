const miio = require('miio');
const packageJson = require('./package.json');

let PlatformAccessory, Service, Characteristic, UUIDGen;

const PLATFORM_NAME = 'XiaomiAirPurifierPlatform';
const PLUGIN_NAME = 'homebridge-xiaomi-airpurifier';

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

    this.api.on('didFinishLaunching', () => {
      this.discoverDevices();
    });
  }

  configureAccessory(accessory) {
    this.log.info(`Loading accessory from cache: ${accessory.displayName}`);
    this.accessories.push(accessory);
  }

  discoverDevices() {
    const configuredDevices = this.config.deviceCfgs || [];
    const foundAccessories = [];

    for (const deviceConfig of configuredDevices) {
      if (!deviceConfig.ip || !deviceConfig.token || !deviceConfig.name || !deviceConfig.type) {
        this.log.warn('A device in your configuration is missing ip, token, name, or type. Skipping.');
        continue;
      }
      
      const supportedModels = ['MiAirPurifier2S', 'MiAirPurifierPro'];
      if(!supportedModels.includes(deviceConfig.type)) {
        this.log.warn(`Device type '${deviceConfig.type}' is not supported by this plugin. Skipping.`);
        continue;
      }

      const uuid = UUIDGen.generate(deviceConfig.ip);
      const existingAccessory = this.accessories.find(acc => acc.UUID === uuid);

      if (existingAccessory) {
        this.log.info(`Restoring existing accessory: ${existingAccessory.displayName}`);
        existingAccessory.context.device = deviceConfig;
        new DeviceHandler(this, existingAccessory);
        foundAccessories.push(existingAccessory);
      } else {
        this.log.info(`Adding new accessory: ${deviceConfig.name}`);
        const accessory = new PlatformAccessory(deviceConfig.name, uuid);
        accessory.context.device = deviceConfig;
        new DeviceHandler(this, accessory);
        this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
        this.accessories.push(accessory);
        foundAccessories.push(accessory);
      }
    }
    
    // Unregister stale accessories
    const accessoriesToUnregister = this.accessories.filter(
        acc => !foundAccessories.some(foundAcc => foundAcc.UUID === acc.UUID)
    );
    if(accessoriesToUnregister.length > 0) {
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
    this.device = null; // miio device instance
    this.state = {}; // cache for device state

    // Connect to the device
    this.connect();
    
    // Setup services
    this.setupAccessoryInfo();
    this.setupAirPurifier();
    
    if (this.config.showAirQuality !== false) this.setupAirQualitySensor();
    if (this.config.showTemperature !== false) this.setupTemperatureSensor();
    if (this.config.showHumidity !== false) this.setupHumiditySensor();
    if (this.config.showLED === true) this.setupLedSwitch();
    if (this.config.showBuzzer === true) this.setupBuzzerSwitch();
  }

  async connect() {
    try {
      this.log.info(`Connecting to ${this.config.name} at ${this.config.ip}...`);
      this.device = await miio.device({ address: this.config.ip, token: this.config.token });
      this.log.info(`Successfully connected to ${this.config.name}.`);
    } catch (e) {
      this.log.error(`Failed to connect to ${this.config.name}. Retrying in 30 seconds. Error: ${e.message}`);
      setTimeout(() => this.connect(), 30000);
    }
  }
  
  async getPropertyValue(prop) {
    if (!this.device) {
        throw new Error('Device not connected');
    }
    try {
        const [value] = await this.device.call('get_prop', [prop]);
        return value;
    } catch (e) {
        this.log.error(`Error getting property '${prop}' from ${this.config.name}: ${e.message}`);
        this.connect(); // Attempt to reconnect
        throw e;
    }
  }
  
  async setPropertyValue(method, value) {
      if (!this.device) {
          throw new Error('Device not connected');
      }
      try {
          const result = await this.device.call(method, value);
          if (result[0] !== 'ok') {
              throw new Error(`Device returned an error: ${result[0]}`);
          }
      } catch (e) {
          this.log.error(`Error setting property with method '${method}' on ${this.config.name}: ${e.message}`);
          this.connect(); // Attempt to reconnect
          throw e;
      }
  }

  setupAccessoryInfo() {
    this.accessory.getService(Service.AccessoryInformation)
      .setCharacteristic(Characteristic.Manufacturer, 'Xiaomi')
      .setCharacteristic(Characteristic.Model, this.config.type)
      .setCharacteristic(Characteristic.SerialNumber, this.config.ip);
  }

  setupAirPurifier() {
    this.service = this.accessory.getService(Service.AirPurifier) || this.accessory.addService(Service.AirPurifier, this.config.name);

    this.service.getCharacteristic(Characteristic.Active)
      .onGet(async () => (await this.getPropertyValue('power')) === 'on' ? Characteristic.Active.ACTIVE : Characteristic.Active.INACTIVE)
      .onSet(async (value) => this.setPropertyValue('set_power', [value ? 'on' : 'off']));

    this.service.getCharacteristic(Characteristic.CurrentAirPurifierState)
      .onGet(async () => {
        const power = await this.getPropertyValue('power');
        return power === 'on' ? Characteristic.CurrentAirPurifierState.PURIFYING_AIR : Characteristic.CurrentAirPurifierState.INACTIVE;
      });

    this.service.getCharacteristic(Characteristic.TargetAirPurifierState)
      .onGet(async () => {
        const mode = await this.getPropertyValue('mode');
        return mode === 'favorite' ? Characteristic.TargetAirPurifierState.MANUAL : Characteristic.TargetAirPurifierState.AUTO;
      })
      .onSet(async (value) => this.setPropertyValue('set_mode', [value === Characteristic.TargetAirPurifierState.AUTO ? 'auto' : 'favorite']));
      
    this.service.getCharacteristic(Characteristic.RotationSpeed)
      .onGet(async () => {
          // HomeKit speed is 0-100, Xiaomi favorite_level is 0-17. We'll map it.
          const level = await this.getPropertyValue('favorite_level');
          return Math.round((level / 17) * 100);
      })
      .onSet(async (value) => {
          const level = Math.round((value / 100) * 17);
          await this.setPropertyValue('set_favorite_level', [level]);
      });

    this.service.getCharacteristic(Characteristic.FilterChangeIndication)
        .onGet(async () => {
            const life = await this.getPropertyValue('filter1_life');
            return life < 5 ? Characteristic.FilterChangeIndication.CHANGE_FILTER : Characteristic.FilterChangeIndication.FILTER_OK;
        });

    this.service.getCharacteristic(Characteristic.FilterLifeLevel)
        .onGet(async () => await this.getPropertyValue('filter1_life'));
  }

  setupAirQualitySensor() {
    const service = this.accessory.getService(Service.AirQualitySensor) || this.accessory.addService(Service.AirQualitySensor, `${this.config.name} Air Quality`);
    
    service.getCharacteristic(Characteristic.AirQuality)
      .onGet(async () => {
        const aqi = await this.getPropertyValue('aqi');
        if (aqi <= 5) {
            return Characteristic.AirQuality.EXCELLENT;
        } else if (aqi > 5 && aqi <= 15) {
            return Characteristic.AirQuality.GOOD;
        } else if (aqi > 15 && aqi <= 35) {
            return Characteristic.AirQuality.FAIR;
        } else if (aqi > 35 && aqi <= 55) {
            return Characteristic.AirQuality.INFERIOR;
        } else if (aqi > 55) {
            return Characteristic.AirQuality.POOR;
        } else {
            return Characteristic.AirQuality.UNKNOWN;
        }
      });
      
    service.getCharacteristic(Characteristic.PM2_5Density)
        .onGet(async () => await this.getPropertyValue('aqi'));
  }
  
  setupTemperatureSensor() {
      const service = this.accessory.getService(Service.TemperatureSensor) || this.accessory.addService(Service.TemperatureSensor, `${this.config.name} Temperature`);
      service.getCharacteristic(Characteristic.CurrentTemperature)
        .onGet(async () => (await this.getPropertyValue('temp_dec')) / 10);
  }
  
  setupHumiditySensor() {
      const service = this.accessory.getService(Service.HumiditySensor) || this.accessory.addService(Service.HumiditySensor, `${this.config.name} Humidity`);
      service.getCharacteristic(Characteristic.CurrentRelativeHumidity)
        .onGet(async () => await this.getPropertyValue('humidity'));
  }
  
  setupLedSwitch() {
      const service = this.accessory.getService('LED') || this.accessory.addService(Service.Switch, `${this.config.name} LED`, 'LED');
      service.getCharacteristic(Characteristic.On)
        .onGet(async () => (await this.getPropertyValue('led')) === 'on')
        .onSet(async (value) => {
            // Air Purifier Pro uses `set_led_b` with 0, 1, or 2. 2S uses `set_led` with `on/off`.
            if (this.config.type === 'MiAirPurifierPro') {
                await this.setPropertyValue('set_led_b', [value ? 0 : 2]); // 0=bright, 1=dim, 2=off
            } else {
                await this.setPropertyValue('set_led', [value ? 'on' : 'off']);
            }
        });
  }
  
  setupBuzzerSwitch() {
      const service = this.accessory.getService('Buzzer') || this.accessory.addService(Service.Switch, `${this.config.name} Buzzer`, 'Buzzer');
      service.getCharacteristic(Characteristic.On)
        .onGet(async () => {
            const volume = await this.getPropertyValue('volume');
            return volume > 0;
        })
        .onSet(async (value) => this.setPropertyValue('set_volume', [value ? 50 : 0])); // Set to a moderate volume or off
  }
}
