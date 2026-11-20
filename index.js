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
    this.storagePath = config.storagePath || api.user.storagePath();
    this.intervalMinutes = config.intervalMinutes || 10;
    this.diffThreshold = config.diffThreshold || 20;
    this.roi = config.roi || new Array(100, 50, 120, 80);

    this.refImagePath = path.join(this.storagePath, `gate_ref_${this.serialNumber}.jpg`);
    this.eufyDataDir = path.join(this.storagePath, `eufy_data_${this.serialNumber}`);

    if (!fs.existsSync(this.storagePath)) {
      fs.mkdirSync(this.storagePath, { recursive: true });
    }

    this.Service = api.hap.Service;
    this.Characteristic = api.hap.Characteristic;

    this.sensorService = new this.Service.ContactSensor(this.name, 'gate-sensor');
    this.currentState = this.Characteristic.ContactSensorState.CONTACT_DETECTED;

    this.sensorService.getCharacteristic(this.Characteristic.ContactSensorState)
      .onGet(() => this.currentState);

    this.calibrateSwitch = new this.Service.Switch(`${this.name} Calibrate`, 'calibrate-switch');
    this.calibrateSwitch.getCharacteristic(this.Characteristic.On)
      .onGet(() => false)
      .onSet(async (value) => {
        if (value) {
          this.log.info('Calibrate button pressed! Capturing new CLOSED reference snapshot...');
          await this.checkGateStatus(true); // true = força a gravação do novo screenshot de referência

          setTimeout(() => {
            this.calibrateSwitch.updateCharacteristic(this.Characteristic.On, false);
          }, 1000);
        }
      });

    this.initEufy();
  }

  async initEufy() {
    try {
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

      await this.eufy.connect();
      this.log.info('Successfully connected to Eufy account!');

      setTimeout(() => this.checkGateStatus(false), 10000);
      setInterval(() => this.checkGateStatus(false), this.intervalMinutes * 60 * 1000);

    } catch (error) {
      this.log.error('Failed to connect to Eufy account:', error.message);
    }
  }

  async checkGateStatus(forceNewReference = false) {
    try {
      if (!this.eufy) {
        this.log.warn('Eufy client is not connected yet.');
        return;
      }

      const device = await this.eufy.getDevice(this.serialNumber);
      if (!device) {
        this.log.error('Camera not found. Please check your Serial Number in config.');
        return;
      }

      const station = await this.eufy.getStation(device.getStationSerial());
      if (station && station.isConnected()) {
        await station.getCameraInfo(device);
      }

      const picture = device.getPropertyValue(PropertyName.DevicePicture);
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
      this.log.error('Error analyzing camera snapshot:', error.message);
    }
  }

  calculateImageDifference(img1, img2) {
    const roiValues = Object.values(this.roi);
    const x0 = roiValues[0];
    const y0 = roiValues[1];
    const width = roiValues[2];
    const height = roiValues[3];

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
