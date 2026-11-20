const { EufySecurity, PropertyName } = require('eufy-security-client');
const { execSync } = require('child_process');
const fs = require('fs');
const jpeg = require('jpeg-js');

module.exports = (api) => {
  api.registerAccessory('EufyGateSensor', EufyGateSensorAccessory);
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
    this.brightnessThreshold = config.brightnessThreshold || 100;
    // Region of Interest (ROI): [x, y, width, height] on a 320x180 scaled image
this.roi = config.roi || new Array(100, 50, 120, 80);

    this.Service = api.hap.Service;
    this.Characteristic = api.hap.Characteristic;

    this.service = new this.Service.ContactSensor(this.name);
    this.currentState = this.Characteristic.ContactSensorState.CONTACT_DETECTED; // Closed by default

    this.service.getCharacteristic(this.Characteristic.ContactSensorState)
      .onGet(() => this.currentState);

    this.initEufy();
  }

  async initEufy() {
    try {
      this.eufy = await EufySecurity.initialize({
        username: this.email,
        password: this.password,
        country: this.country,
        language: 'en',
        persistentDir: '/tmp/eufy_gate_data',
        p2pConnectionSetup: 0,
        pollingIntervalMinutes: this.intervalMinutes,
        eventDurationSeconds: 10
      });

      await this.eufy.connect();
      this.log.info('Successfully connected to Eufy account!');

      // First check after 10 seconds, then every X minutes
      setTimeout(() => this.checkGateStatus(), 10000);
      setInterval(() => this.checkGateStatus(), this.intervalMinutes * 60 * 1000);

    } catch (error) {
      this.log.error('Failed to connect to Eufy account:', error.message);
    }
  }

  async checkGateStatus() {
    try {
      const device = await this.eufy.getDevice(this.serialNumber);
      if (!device) {
        this.log.error('Camera not found. Please check your Serial Number in config.');
        return;
      }

      // Request snapshot update from station/camera
      const station = await this.eufy.getStation(device.getStationSerial());
      if (station && station.isConnected()) {
        await station.getCameraInfo(device);
      }

      const picture = device.getPropertyValue(PropertyName.DevicePicture);
      if (!picture || !picture.data) {
        this.log.warn('No snapshot available from camera yet.');
        return;
      }

      const rawFile = '/tmp/gate_raw.jpg';
      const scaledFile = '/tmp/gate_scaled.jpg';
      fs.writeFileSync(rawFile, Buffer.from(picture.data));

      // Scale down to 320x180 with ffmpeg to save RAM on Raspberry Pi Zero
      execSync(`ffmpeg -y -i ${rawFile} -s 320x180 ${scaledFile}`);

      const jpegData = fs.readFileSync(scaledFile);
      const rawImage = jpeg.decode(jpegData, { useTArray: true });
      const avgBrightness = this.calculateZoneBrightness(rawImage);

      const isOpen = avgBrightness < this.brightnessThreshold;
      this.currentState = isOpen
        ? this.Characteristic.ContactSensorState.CONTACT_NOT_DETECTED
        : this.Characteristic.ContactSensorState.CONTACT_DETECTED;

      this.service.updateCharacteristic(this.Characteristic.ContactSensorState, this.currentState);
      this.log.info(`Average brightness: ${avgBrightness.toFixed(1)} | Gate status: ${isOpen ? 'OPEN' : 'CLOSED'}`);

    } catch (error) {
      this.log.error('Error analyzing camera snapshot:', error.message);
    }
  }

  calculateZoneBrightness(img) {
    const [x0, y0, width, height] = this.roi;
    let sum = 0;
    let pixelCount = 0;

    for (let y = y0; y < y0 + height; y++) {
      for (let x = x0; x < x0 + width; x++) {
        const idx = (img.width * y + x) << 2;
        const luminance = 0.299 * img.data[idx] + 0.587 * img.data[idx + 1] + 0.114 * img.data[idx + 2];
        sum += luminance;
        pixelCount++;
      }
    }
    return sum / pixelCount;
  }

  getServices() {
    return [this.service];
  }
}
