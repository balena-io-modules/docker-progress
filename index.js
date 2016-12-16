// Generated by CoffeeScript 1.11.1
(function() {
  var DEFAULT_PROGRESS_BAR_STEP_COUNT, Docker, DockerProgress, LEGACY_DOCKER_VERSION, ProgressReporter, ProgressTracker, Promise, _, combinedProgressHandler, onProgressHandler, renderProgress, semver;

  _ = require('lodash');

  semver = require('semver');

  Promise = require('bluebird');

  Docker = require('docker-toolbelt');

  LEGACY_DOCKER_VERSION = '1.10.0';

  DEFAULT_PROGRESS_BAR_STEP_COUNT = 50;

  renderProgress = function(percentage, stepCount) {
    var bar, barCount, spaceCount;
    percentage = Math.min(Math.max(percentage, 0), 100);
    barCount = Math.floor(stepCount * percentage / 100);
    spaceCount = stepCount - barCount;
    bar = "[" + (_.repeat('=', barCount)) + ">" + (_.repeat(' ', spaceCount)) + "]";
    return bar + " " + percentage + "%";
  };

  onProgressHandler = function(onProgressPromise, fallbackOnProgress) {
    var evts, onProgress;
    evts = [];
    onProgress = function(evt) {
      return evts.push(evt);
    };
    onProgressPromise.then(function(resolvedOnProgress) {
      return onProgress = resolvedOnProgress;
    })["catch"](function(e) {
      console.warn('error', e);
      return onProgress = fallbackOnProgress;
    }).then(function() {
      return _.map(evts, function(evt) {
        try {
          return onProgress(evt);
        } catch (error) {}
      });
    });
    return function(evt) {
      return onProgress(evt);
    };
  };

  combinedProgressHandler = function(renderer, states, index, callback) {
    return function(evt) {
      var percentage;
      states[index].percentage = evt.percentage;
      percentage = Math.floor(_.sumBy(states, 'percentage') / (states.length || 1));
      evt.totalProgress = renderer(percentage);
      evt.percentage = percentage;
      evt.progressIndex = index;
      return callback(evt);
    };
  };

  ProgressTracker = (function() {
    function ProgressTracker(coalesceBelow) {
      this.coalesceBelow = coalesceBelow != null ? coalesceBelow : 0;
      this.layers = {};
    }

    ProgressTracker.prototype.addLayer = function(id) {
      return this.layers[id] = {
        progress: null,
        coalesced: false
      };
    };

    ProgressTracker.prototype.updateLayer = function(id, progress) {
      if (id == null) {
        return;
      }
      if (!this.layers[id]) {
        this.addLayer(id);
      }
      this.patchProgressEvent(progress);
      this.layers[id].coalesced = (this.layers[id].progress == null) && progress.total < this.coalesceBelow;
      return this.layers[id].progress = (progress.current / progress.total) || 0;
    };

    ProgressTracker.prototype.finishLayer = function(id) {
      return this.updateLayer(id, {
        current: 1,
        total: 1
      });
    };

    ProgressTracker.prototype.getProgress = function() {
      var layerCount, layers, progress;
      layers = _.filter(this.layers, {
        coalesced: false
      });
      layerCount = layers.length || 1;
      progress = _.sumBy(layers, 'progress');
      return Math.round(100 * progress / layerCount);
    };

    ProgressTracker.prototype.patchProgressEvent = function(progress) {
      if (progress.total == null) {
        progress.total = progress.current;
      }
      return progress.current = Math.min(progress.current, progress.total);
    };

    return ProgressTracker;

  })();

  ProgressReporter = (function() {
    function ProgressReporter(renderProgress1) {
      this.renderProgress = renderProgress1;
    }

    ProgressReporter.prototype.pullProgress = function(image, onProgress) {
      var downloadProgressTracker, extractionProgressTracker, lastPercentage, progressRenderer;
      progressRenderer = this.renderProgress;
      downloadProgressTracker = new ProgressTracker(100 * 1024);
      extractionProgressTracker = new ProgressTracker(1024 * 1024);
      lastPercentage = 0;
      return Promise["try"](function() {
        return function(evt) {
          var downloadedPercentage, err, extractedPercentage, id, percentage, ref, status;
          try {
            id = evt.id, status = evt.status;
            if (status === 'Pulling fs layer') {
              downloadProgressTracker.addLayer(id);
              extractionProgressTracker.addLayer(id);
            } else if (status === 'Downloading') {
              downloadProgressTracker.updateLayer(id, evt.progressDetail);
            } else if (status === 'Extracting') {
              extractionProgressTracker.updateLayer(id, evt.progressDetail);
            } else if (status === 'Download complete') {
              downloadProgressTracker.finishLayer(id);
            } else if (status === 'Pull complete') {
              extractionProgressTracker.finishLayer(id);
            } else if (status === 'Already exists') {
              downloadProgressTracker.finishLayer(id);
              extractionProgressTracker.finishLayer(id);
            }
            if (status.match(/^Status: Image is up to date for /) || status.match(/^Status: Downloaded newer image for /)) {
              downloadedPercentage = 100;
              extractedPercentage = 100;
            } else {
              downloadedPercentage = downloadProgressTracker.getProgress();
              extractedPercentage = extractionProgressTracker.getProgress();
            }
            percentage = Math.floor((downloadedPercentage + extractedPercentage) / 2);
            percentage = lastPercentage = Math.max(percentage, lastPercentage);
            return onProgress(_.merge(evt, {
              percentage: percentage,
              downloadedPercentage: downloadedPercentage,
              extractedPercentage: extractedPercentage,
              totalProgress: progressRenderer(percentage)
            }));
          } catch (error) {
            err = error;
            return console.warn('Progress error:', (ref = err.message) != null ? ref : err);
          }
        };
      });
    };

    ProgressReporter.prototype.pushProgress = function(image, onProgress) {
      var lastPercentage, progressRenderer, progressTracker;
      progressRenderer = this.renderProgress;
      progressTracker = new ProgressTracker(100 * 1024);
      lastPercentage = 0;
      return Promise["try"](function() {
        return function(evt) {
          var err, id, percentage, pushMatch, ref, status;
          try {
            id = evt.id, status = evt.status;
            pushMatch = /Image (.*) already pushed/.exec(status);
            if (id == null) {
              id = pushMatch != null ? pushMatch[1] : void 0;
            }
            if (status == null) {
              status = '';
            }
            if (status === 'Preparing') {
              progressTracker.addLayer(id);
            } else if (status === 'Pushing' && (evt.progressDetail.current != null)) {
              progressTracker.updateLayer(id, evt.progressDetail);
            } else if (_.includes(['Pushed', 'Layer already exists', 'Image already exists'], status) || /^Mounted from /.test(status)) {
              progressTracker.finishLayer(id);
            } else if ((pushMatch != null) || _.includes(['Already exists', 'Image successfully pushed'], status)) {
              progressTracker.finishLayer(id);
            }
            percentage = status.match(/^latest: digest: /) || status.match(/^Pushing tag for rev /) ? 100 : progressTracker.getProgress();
            percentage = lastPercentage = Math.max(percentage, lastPercentage);
            return onProgress(_.merge(evt, {
              id: id,
              percentage: percentage,
              totalProgress: progressRenderer(percentage)
            }));
          } catch (error) {
            err = error;
            return console.warn('Progress error:', (ref = err.message) != null ? ref : err);
          }
        };
      });
    };

    return ProgressReporter;

  })();

  exports.DockerProgress = DockerProgress = (function() {
    function DockerProgress(dockerOpts) {
      if (!(this instanceof DockerProgress)) {
        return new DockerProgress(dockerOpts);
      }
      this.docker = new Docker(dockerOpts);
      this.reporter = null;
    }

    DockerProgress.prototype.getProgressRenderer = function(stepCount) {
      if (stepCount == null) {
        stepCount = DEFAULT_PROGRESS_BAR_STEP_COUNT;
      }
      return function(percentage) {
        return renderProgress(percentage, stepCount);
      };
    };

    DockerProgress.prototype.getProgressReporter = function() {
      var docker, renderer;
      if (this.reporter != null) {
        return this.reporter;
      }
      docker = this.docker;
      renderer = this.getProgressRenderer();
      return this.reporter = docker.versionAsync().then(function(res) {
        var LegacyProgressReporter, version;
        version = res['Version'];
        if ((version != null) && semver.lt(version, LEGACY_DOCKER_VERSION)) {
          LegacyProgressReporter = require('./legacy').ProgressReporter;
          return new LegacyProgressReporter(renderer, docker);
        } else {
          return new ProgressReporter(renderer);
        }
      });
    };

    DockerProgress.prototype.aggregateProgress = function(count, onProgress) {
      var i, j, ref, renderer, reporters, states;
      renderer = this.getProgressRenderer();
      states = [];
      reporters = [];
      for (i = j = 0, ref = count; 0 <= ref ? j < ref : j > ref; i = 0 <= ref ? ++j : --j) {
        states.push({
          percentage: 0
        });
        reporters.push(combinedProgressHandler(renderer, states, i, onProgress));
      }
      return reporters;
    };

    DockerProgress.prototype.pull = function(image, onProgress, callback) {
      var onProgressPromise;
      onProgressPromise = this.pullProgress(image, onProgress);
      onProgress = onProgressHandler(onProgressPromise, onProgress);
      return this.docker.pullAsync(image).then((function(_this) {
        return function(stream) {
          return Promise.fromCallback(function(callback) {
            return _this.docker.modem.followProgress(stream, callback, onProgress);
          });
        };
      })(this)).nodeify(callback);
    };

    DockerProgress.prototype.push = function(image, onProgress, options, callback) {
      var onProgressPromise;
      onProgressPromise = this.pushProgress(image, onProgress);
      onProgress = onProgressHandler(onProgressPromise, onProgress);
      return this.docker.getImage(image).pushAsync(options).then((function(_this) {
        return function(stream) {
          return Promise.fromCallback(function(callback) {
            return _this.docker.modem.followProgress(stream, callback, onProgress);
          });
        };
      })(this)).nodeify(callback);
    };

    DockerProgress.prototype.pullProgress = function(image, onProgress) {
      return this.getProgressReporter().then(function(reporter) {
        return reporter.pullProgress(image, onProgress);
      });
    };

    DockerProgress.prototype.pushProgress = function(image, onProgress) {
      return this.getProgressReporter().then(function(reporter) {
        return reporter.pushProgress(image, onProgress);
      });
    };

    return DockerProgress;

  })();

}).call(this);
