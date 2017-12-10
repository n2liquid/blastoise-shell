let cp = require('child_process');
let fs = require('fs');
let isRunning = require('is-running');
let { Readable } = require('stream');

let PLazy = require('p-lazy');
let streamToString = require('stream-to-string');

let expandArgs = require('./expandArgs');
let proxyWrap = require('./proxyWrap');
let streamForEach = require('./streamForEach');

class BlastoiseError extends Error {
}

let msg = {
  invalidDest: `Invalid pipe destination`,
  invalidShell: `Invalid shell`,
  //invalidSrc: `Invalid pipe source`,
  procAlreadyDead: `Process already dead`,
  procAlreadyStarted: `Process already started`,
};

function cantPipeFrom(src, why) {
  if (src instanceof BlastoiseShell) {
    src = src.cmd || 'null shell';
  }

  throw new BlastoiseError(
    `Can't pipe from ${src}: ${why}`
  );
}

function cantPipeTo(dest, why) {
  if (dest instanceof BlastoiseShell) {
    dest = dest.cmd || 'null shell';
  }

  throw new BlastoiseError(
    `Can't pipe to ${dest}: ${why}`
  );
}

function cantStart(sh, why) {
  sh = sh.cmd || 'null shell';

  throw new BlastoiseError(
    `Can't start ${sh}: ${why}`
  );
}

let inheritedProps = ['_throwOnError'];

class BlastoiseShell extends Promise {
  constructor(cmd, ...args) {
    super(resolve => resolve());

    this.cmd = cmd || null;
    this.args = expandArgs(args);

    this._throwOnError = true;

    if (this.cmd) {
      this.spawnConf = {
        stdin: 'inherit',
        stdout: 'inherit',
        stderr: 'inherit',
      };
    }

    this.proc = null;
  }

  throwOnError(val) {
    let next = new BlastoiseShell();

    this.pipeTo(next);

    if (val === undefined) {
      val = true;
    }

    next._throwOnError = !!val;

    return proxyWrap(next);
  }

  pipeTo(dest, ...args) {
    if (this.proc) {
      cantPipeFrom(this, msg.procAlreadyStarted);
    }

    if (typeof dest === 'string') {
      return this.pipeToExec(dest, ...args);
    }

    if (typeof dest === 'function') {
      return dest(this, ...args);
    }

    if (dest instanceof BlastoiseShell) {
      return this.pipeToShell(dest);
    }

    cantPipeTo(dest, msg.invalidDest);
  }

  pipeToExec(cmd, ...args) {
    if (this.proc) {
      cantPipeFrom(this, msg.procAlreadyStarted);
    }

    let next = new BlastoiseShell(cmd, ...args);
    this.pipeTo(next);

    return proxyWrap(next);
  }

  pipeToShell(next) {
    if (this.proc) {
      cantPipeFrom(this, msg.procAlreadyStarted);
    }

    if (next.proc) {
      cantPipeTo(next, msg.procAlreadyStarted);
    }

    for (let k of inheritedProps) {
      next[k] = this[k];
    }

    if (this.cmd) {
      this.spawnConf.stdout = next;
      next.spawnConf.stdin = this;
    }

    return next;
  }

  start() {
    if (this.promise) {
      return this.promise;
    }

    if (!this.cmd) {
      cantStart(this, msg.invalidShell);
    }

    let { stdin, stdout, stderr } = this.spawnConf;
    delete this.spawnConf;

    let pStdinShell = null;

    if (stdin instanceof BlastoiseShell) {
      pStdinShell = stdin.start();

      if (!isRunning(stdin.proc.pid)) {
        cantPipeFrom(stdin, msg.procAlreadyDead);
      }
    }

    if (this.redirect) {
      this.proc = {
        pid: stdin.proc.pid,
        stdout: stdin.proc[this.redirect],
      };

      return this.promise = pStdinShell;
    }

    let proc = this.proc = cp.spawn(this.cmd, this.args, {
      stdio: [stdin, stdout, stderr].map(x => {
        if (typeof x === 'object') {
          return 'pipe';
        }

        return x;
      }),
    });

    if (pStdinShell) {
      stdin.proc.stdout.pipe(proc.stdin);
    }
    else if (stdin instanceof Readable) {
      stdin.pipe(proc.stdin);
    }

    let pProcDone = new Promise((resolve, reject) => {
      proc.on('error', err => {
        if (!this._throwOnError) {
          return resolve(err.code);
        }

        reject(err);
      });

      proc.on('exit', (code, sig) => {
        if (!this._throwOnError) {
          return resolve(code !== null ? code : sig);
        }

        if (code === 0) {
          return resolve(code);
        }

        if (code === null) {
          return reject(new BlastoiseError(
            `${this.cmd} terminated by signal ${sig}`
          ));
        }

        reject(new BlastoiseError(
          `${this.cmd} exitted with code ${code}`
        ));
      });
    });

    let pPipesFinished = Promise.all(
      ['stdout', 'stderr'].map(x => new Promise(
        (resolve, reject) => {
          if (!proc[x]) {
            return resolve();
          }

          proc[x].on('error', reject);
          proc[x].on('finish', resolve);
        }
      ))
    );

    this.promise = Promise.all([
      pProcDone, pPipesFinished, pStdinShell,
    ])
    .then(xs => xs[0]);

    return this.promise;
  }

  appendTo(path) {
    return new PLazy(resolve => {
      if (this.proc) {
        cantPipeFrom(this, msg.procAlreadyStarted);
      }

      this.spawnConf.stdout = 'pipe';

      resolve(Promise.all([
        this.start(), new Promise((resolve, reject) => {
          let fileStream = fs.createWriteStream(path, {
            flags: 'a',
          });

          this.proc.stdout.pipe(fileStream);

          fileStream.on('error', reject);
          fileStream.on('finish', resolve);
        }),
      ]));
    });
  }

  writeTo(path) {
    return new PLazy(resolve => {
      if (this.proc) {
        cantPipeFrom(this, msg.procAlreadyStarted);
      }

      this.spawnConf.stdout = 'pipe';

      resolve(Promise.all([
        this.start(), new Promise((resolve, reject) => {
          let fileStream = fs.createWriteStream(path);

          this.proc.stdout.pipe(fileStream);

          fileStream.on('error', reject);
          fileStream.on('finish', resolve);
        }),
      ]));
    });
  }

  toString() {
    return new PLazy(resolve => {
      if (this.proc) {
        cantPipeFrom(this, msg.procAlreadyStarted);
      }

      this.spawnConf.stdout = 'pipe';

      resolve(Promise.all([
        this.start(),
        streamToString(this.proc.stdout),
      ])
      .then(xs => xs[1]));
    });
  }

  forEach(fn) {
    return new PLazy(resolve => {
      if (this.proc) {
        cantPipeFrom(this, msg.procAlreadyStarted);
      }

      this.spawnConf.stdout = 'pipe';

      resolve(Promise.all([
        this.start(),
        streamForEach(this.proc.stdout, fn),
      ])
      .then(xs => xs[1]));
    });
  }

  map(fn) {
    return this.forEach(x => Promise.resolve(
      fn(x)
    ));
  }

  get lines() {
    return this.map(x => x);
  }

  get err() {
    let next = new BlastoiseShell(this.cmd, ...this.args);

    this.spawnConf.stderr = next;

    next.spawnConf.stdin = this;
    next.redirect = 'stderr';

    return proxyWrap(next);
  }

  then(...args) {
    return this.start().then(...args);
  }

  catch(...args) {
    return this.start().catch(...args);
  }
}

module.exports = proxyWrap(new BlastoiseShell());
