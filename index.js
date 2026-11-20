const { EufySecurity, PropertyName } = require('eufy-security-client');
const { execSync } = require('child_process');
const fs = require('fs');
const jpeg = require('jpeg-js');
const os = require('os');
const path = require('path');

let ffmpegPath = 'ffmpeg';
try {
  ffmpegPath = require('ffmpeg-for-homebridge') || 'ffmpeg';
} catch (e) {
}

module.exports = (api) => {
  api.registerAccessory('homebridge-eufy-gate-sensor', 'EufyGateSensor', EufyGateSensorAccessory);
};

class EufyGateSensorAccessory {
  constructor(log, config, api) {
    this.log = log;
    this.name = config.name || 'Gate';
    this.email = config.email;
    this.password = config.password;
    this.serialNumber = config.serialNumber;
    this.country = config.country || 'PT';
    this.intervalMinutes = config.intervalMinutes || 10;
    this.diffThreshold = config.diffThreshold || 20;
    this.roi = config.roi || new Array(100, 50, 120, 80);

    this.storagePath = config.storagePath || api.user.storagePath();
    if (!fs.existsSync(this.storagePath)) {
      fs.mkdirSync(this.storagePath, { recursive: true });
    }

    this.refImagePath = path.join(this.storagePath, `gate_ref_${this.serialNumber}.jpg`);
    this.eufyDataDir = path.join(this.storagePath, `eufy_data_${this.serialNumber}`);

    if (!fs.existsSync(this.eufyDataDir)) {
      fs.mkdirSync(this.eufyDataDir, { recursive: true });
    }

    const cooldownSeconds = config.cooldownSeconds !== undefined ? config.cooldownSeconds : 15;
    this.cooldownMs = cooldownSeconds * 1000;
    this.isChecking = false;
    this.lastCheckTime = 0;

    this.Service = api.hap.Service;
    this.Characteristic = api.hap.Characteristic;

    this.sensorService = new this.Service.ContactSensor(this.name, 'gate-sensor');
    this.currentState = this.Characteristic.ContactSensorState.CONTACT_DETECTED;

    this.sensorService.getCharacteristic(this.Characteristic.ContactSensorState)
      .onGet(() => this.currentState);

    this.calibrateSwitch = new this.Service.Switch(`${this.name} Calibrate`, 'calibrate-switch');
    this.calibrateSwitch.getCharacteristic(this.Characteristic.On)
      .onGet(() => this.isChecking || (Date.now() - this.lastCheckTime < this.cooldownMs))
      .onSet(async (value) => {
        if (value) {
          if (this.isChecking || (Date.now() - this.lastCheckTime < this.cooldownMs)) {
            const waitSec = Math.ceil(this.cooldownMs / 1000);
            this.log.warn(`Button ignored: please wait ${waitSec} seconds between captures.`);
            setTimeout(() => {
              this.calibrateSwitch.updateCharacteristic(this.Characteristic.On, false);
            }, 500);
            return;
          }

          this.log.info('Calibrate button pressed! Capturing new CLOSED reference snapshot...');
          await this.checkGateStatus(true);

          setTimeout(() => {
            this.calibrateSwitch.updateCharacteristic(this.Characteristic.On, false);
          }, this.cooldownMs);
        }
      });

    this.initEufy();
  }

  async initEufy() {
    try {
      this.log.info(`Initializing Eufy client for ${this.email} (Country: ${this.country})...`);

      this.eufy = await EufySecurity.initialize({
        username: this.email,
        password: this.password,
        country: this.country,
        language: 'en',
        persistentDir: this.eufyDataDir,
        p2pConnectionSetup: 0,
        pollingIntervalMinutes: this.intervalMinutes,
        eventDurationSeconds: 10
      });

      this.eufy.on('connect', () => {
        this.log.info('EVENT: Connected to Eufy cloud and stations!');
      });

      this.eufy.on('close', () => {
        this.log.warn('EVENT: Connection to Eufy closed.');
      });

      this.eufy.on('tfa request', () => {
        this.log.error('EVENT: Eufy is asking for 2FA (Two-Factor Authentication) code! Disable 2FA on this secondary account.');
      });

      this.eufy.on('captcha request', (id, captcha) => {
        this.log.error('EVENT: Eufy is asking for a CAPTCHA! Log in once on the Eufy mobile app with this account to clear it.');
      });

      this.eufy.on('push connect', () => {
        this.log.info('EVENT: Push notifications connected.');
      });

      this.eufy.on('device added', (device) => {
        this.log.info(`EVENT: Device discovered -> Name: "${device.getName()}" | Serial: "${device.getSerial()}"`);
      });

      await this.eufy.connect();
      this.log.info('eufy.connect() finished. Waiting 15 seconds for devices to sync...');

      setTimeout(() => this.checkGateStatus(false), 15000);
      setInterval(() => this.checkGateStatus(false), this.intervalMinutes * 60 * 1000);

    } catch (error) {
      this.log.error('Failed to initialize Eufy account:', error);
    }
  }

  async checkGateStatus(forceNewReference = false) {
    const now = Date.now();
    const minIntervalMs = this.cooldownMs;

    if (this.isChecking) {
      this.log.warn('Already capturing/analyzing a snapshot. Please wait...');
      return;
    }

    if (now - this.lastCheckTime < minIntervalMs) {
      const remainingSeconds = Math.ceil((minIntervalMs - (now - this.lastCheckTime)) / 1000);
      this.log.warn(`Cooldown active. Please wait ${remainingSeconds}s before taking another snapshot.`);
      return;
    }

    this.isChecking = true;

    try {
      this.log.info('Running checkGateStatus()...');
      if (!this.eufy) {
        this.log.warn('Eufy client is not initialized yet.');
        return;
      }

      const devices = await this.eufy.getDevices();
      this.log.info(`Total devices found in account: ${devices.length}`);

      const device = await this.eufy.getDevice(this.serialNumber);
      if (!device) {
        this.log.error(`Camera with serial "${this.serialNumber}" NOT found! Available serials: ${devices.map(d => d.getSerial()).join(', ')}`);
        return;
      }

      this.log.info(`Found camera "${device.getName()}". Requesting snapshot...`);

      const station = await this.eufy.getStation(device.getStationSerial());
      if (station) {
        this.log.info(`Station "${station.getName()}" connected: ${station.isConnected()}`);
        if (station.isConnected()) {
          await station.getCameraInfo(device);
        }
      }

      const picture = device.getPropertyValue(PropertyName.DevicePicture);
      this.log.info(`DevicePicture property state: ${picture ? (picture.data ? `Buffer (${picture.data.length} bytes)` : 'No data buffer') : 'Undefined'}`);

      if (!picture || !picture.data) {
        this.log.warn('No snapshot available from camera yet.');
        return;
      }

      const rawFile = path.join(os.tmpdir(), `gate_raw_${this.serialNumber}.jpg`);
      const currentScaledFile = path.join(os.tmpdir(), `gate_current_${this.serialNumber}.jpg`);
      fs.writeFileSync(rawFile, Buffer.from(picture.data));

      execSync(`"${ffmpegPath}" -y -i "${rawFile}" -s 320x180 "${currentScaledFile}"`);

      if (!fs.existsSync(this.refImagePath) || forceNewReference) {
        fs.copyFileSync(currentScaledFile, this.refImagePath);
        this.currentState = this.Characteristic.ContactSensorState.CONTACT_DETECTED;
        this.sensorService.updateCharacteristic(this.Characteristic.ContactSensorState, this.currentState);
        this.log.info(`New CLOSED reference snapshot saved at: ${this.refImagePath}`);
        return;
      }

      const currentImg = jpeg.decode(fs.readFileSync(currentScaledFile), { useTArray: true });
      const refImg = jpeg.decode(fs.readFileSync(this.refImagePath), { useTArray: true });

      const diffPercent = this.calculateImageDifference(currentImg, refImg);
      const isOpen = diffPercent > this.diffThreshold;

      this.currentState = isOpen
        ? this.Characteristic.ContactSensorState.CONTACT_NOT_DETECTED
        : this.Characteristic.ContactSensorState.CONTACT_DETECTED;

      this.sensorService.updateCharacteristic(this.Characteristic.ContactSensorState, this.currentState);
      this.log.info(`Visual difference: ${diffPercent.toFixed(1)}% | Gate status: ${isOpen ? 'OPEN' : 'CLOSED'}`);

    } catch (error) {
      this.log.error('Error analyzing camera snapshot:', error);
    } finally {
      this.lastCheckTime = Date.now();
      this.isChecking = false;
    }
  }

  calculateImageDifference(img1, img2) {
    const [x0, y0, width, height] = Object.values(this.roi);

    let totalDiff = 0;
    let pixelCount = 0;

    for (let y = y0; y < y0 + height; y++) {
      for (let x = x0; x < x0 + width; x++) {
        const idx = (img1.width * y + x) << 2;
        const rDiff = Math.abs(img1.data[idx] - img2.data[idx]);
        const gDiff = Math.abs(img1.data[idx + 1] - img2.data[idx + 1]);
        const bDiff = Math.abs(img1.data[idx + 2] - img2.data[idx + 2]);

        totalDiff += (rDiff + gDiff + bDiff) / 3;
        pixelCount++;
      }
    }

    const avgDiff = totalDiff / pixelCount;
    return (avgDiff / 255) * 100;
  }

  getServices() {
    return [this.sensorService, this.calibrateSwitch];
  }
}
