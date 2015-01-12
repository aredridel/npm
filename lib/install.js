"use strict"
// npm install <pkg> <pkg> <pkg>
//
// See doc/install.md for more description

// Managing contexts...
// there's a lot of state associated with an "install" operation, including
// packages that are already installed, parent packages, current shrinkwrap, and
// so on. We maintain this state in a "context" object that gets passed around.
// every time we dive into a deeper node_modules folder, the "family" list that
// gets passed along uses the previous "family" list as its __proto__.  Any
// "resolved precise dependency" things that aren't already on this object get
// added, and then that's passed to the next generation of installation.

module.exports = install

install.usage = "npm install"
              + "\nnpm install <pkg>"
              + "\nnpm install <pkg>@<tag>"
              + "\nnpm install <pkg>@<version>"
              + "\nnpm install <pkg>@<version range>"
              + "\nnpm install <folder>"
              + "\nnpm install <tarball file>"
              + "\nnpm install <tarball url>"
              + "\nnpm install <git:// url>"
              + "\nnpm install <github username>/<github project>"
              + "\n\nCan specify one or more: npm install ./foo.tgz bar@stable /some/folder"
              + "\nIf no argument is supplied and ./npm-shrinkwrap.json is "
              + "\npresent, installs dependencies specified in the shrinkwrap."
              + "\nOtherwise, installs dependencies from ./package.json."

install.completion = function (opts, cb) {
  // install can complete to a folder with a package.json, or any package.
  // if it has a slash, then it's gotta be a folder
  // if it starts with https?://, then just give up, because it's a url
  // for now, not yet implemented.
  var registry = npm.registry
  mapToRegistry("-/short", npm.config, function (er, uri) {
    if (er) return cb(er)

    registry.get(uri, null, function (er, pkgs) {
      if (er) return cb()
      if (!opts.partialWord) return cb(null, pkgs)

      var name = npa(opts.partialWord).name
      pkgs = pkgs.filter(function (p) {
        return p.indexOf(name) === 0
      })

      if (pkgs.length !== 1 && opts.partialWord === name) {
        return cb(null, pkgs)
      }

      mapToRegistry(pkgs[0], npm.config, function (er, uri) {
        if (er) return cb(er)

        registry.get(uri, null, function (er, d) {
          if (er) return cb()
          return cb(null, Object.keys(d["dist-tags"] || {})
                    .concat(Object.keys(d.versions || {}))
                    .map(function (t) {
                      return pkgs[0] + "@" + t
                    }))
        })
      })
    })
  })
}

var url = require("url")
var path = require("path")

var log = require("npmlog")
var readPackageTree = require("read-package-tree")
var chain = require("slide").chain
var archy = require("archy")
var mkdir = require("mkdirp")
var rimraf = require("rimraf")
var fs = require("graceful-fs")

var npm = require("./npm.js")
var fetchPackageMetadata = require("./fetch-package-metadata.js")
var locker = require("./utils/locker.js")
var lock = locker.lock
var unlock = locker.unlock

var inflateShrinkwrap = require("./install/deps.js").inflateShrinkwrap
var loadDeps = require("./install/deps.js").loadDeps
var loadDevDeps = require("./install/deps.js").loadDevDeps
var loadArgs = require("./install/deps.js").loadArgs

var diffTrees = require("./install/diff-trees.js")
var decomposeActions = require("./install/decompose-actions.js")
var validateTree = require("./install/validate-tree.js")

var actions = require("./install/actions.js").actions
var doSerial = require("./install/actions.js").doSerial
var doParallel = require("./install/actions.js").doParallel

function dup(stuff) {
  return JSON.parse(JSON.stringify(stuff))
}

function unlockCB(path, name, cb) {
  return function (er1) {
    var args = arguments
    unlock(path, name, function (er2) {
      if (er1) {
        if (er2) log.warning("unlock "+namej,er2)
        return cb.apply(null, args)
      }
      if (er2) return cb(er2)
      cb.apply(null, args)
    })
  }
}

function beforeCb(cb, before) {
  return function () {
    before()
    cb.apply(null, arguments)
  }
}

function install(args, cb) {
  // the /path/to/node_modules/..
  var where = path.resolve(npm.dir, "..")

  // internal api: install(where, what, cb)
  if (arguments.length === 3) {
    where = args
    args = [].concat(cb) // pass in [] to do default dep-install
    cb = arguments[2]
    log.verbose("install", "where, what", [where, args])
  }

  cb = beforeCb(cb, function () {
    if (Math.round(log.tracker.completed()) !== 1) console.log(log.tracker.debug())
  })

  if (!npm.config.get("global")) {
    args = args.filter(function (a) {
      return path.resolve(a) !== where
    })
  }

  var node_modules = path.resolve(where, "node_modules")
  var staging = path.resolve(node_modules, ".staging")

  cb = unlockCB(node_modules, ".staging", cb)

  chain([
      [lock, node_modules, ".staging"]
    , [rimraf, staging]
    , [readPackageTree, where]
    , [readLocalPackageData, where, chain.last]
    , [debugTree, 'RPT', chain.last]
    , [loadShrinkwrap, chain.last]
    , [thenInstall, node_modules, staging, args, chain.last]
    ], cb)
}

function readLocalPackageData(where, currentTree, cb) {
  fetchPackageMetadata(".", where, function (er, pkg) {
    if (er && er.code !== "ENOPACKAGEJSON") return cb(er)
    currentTree.package = pkg || {}
    cb(null, currentTree)
  })
}

function loadShrinkwrap(currentTree, cb) {
  var idealTree = dup(currentTree)
  var next = function () { cb(null, {currentTree: currentTree, idealTree:idealTree}) }
  if (idealTree.package.shrinkwrap) {
    if (idealTree.package.shrinkwrap.dependencies) {
      return inflateShrinkwrap(idealTree, idealTree.package.shrinkwrap.dependencies, next)
    }
  }
  next()
}

function thenInstall(node_modules, staging, args, T, cb) {
  var currentTree = T.currentTree
  var idealTree = T.idealTree

  // If the user ran `npm install` we're expected to update to
  // the latest version, so ignore the versions in idealTree
  if (! idealTree.package.shrinkwrap && ! args.length) {
    idealTree.children = []
  }

  var fast = log.newGroup("fast")
  var lifecycle = log.newGroup("lifecycle")
  var toplifecycle = lifecycle.newGroup("top")
  var finalize = log.newGroup("finalize")
  var move = log.newGroup("placement")

  var dev = npm.config.get("dev") || ! npm.config.get("production")

  var todo = []
  var steps =
    [ [mkdir, staging]
    , [loadDeps, idealTree, log.newGroup("loadDeps")], //[debugTree, "loadDeps", idealTree]
    , args.length && [loadArgs, args, idealTree, log.newGroup("loadArgs", 2)]//, [debugTree, "loadArgs", idealTree]
    , dev && [loadDevDeps, idealTree, log.newGroup("loadDevDeps", 5)]//, [debugTree, "loadDevDeps", idealTree]
    , [validateTree, idealTree, log.newGroup("validateTree")],
    , [diffTrees, currentTree, idealTree, todo, fast.newGroup("diffTrees")]//, [debugActions, log, "diffTrees", todo]
    , [decomposeActions, todo, fast.newGroup("decomposeActions")], [debugActions, log, "decomposeActions", todo]
    , [doParallel, "fetch", staging, todo, log.newGroup("fetch", 10)]
    , [doParallel, "extract", staging, todo, log.newGroup("extract", 10)]
    , [doParallel, "preinstall", staging, todo, lifecycle.newGroup("preinstall")]
    , [doParallel, "build", staging, todo, lifecycle.newGroup("build")]
    , [doParallel, "remove", staging, todo, move.newGroup("remove")]
    , [doSerial, "finalize", staging, todo, move.newGroup("finalize")]
    , [doSerial, "install", staging, todo, lifecycle.newGroup("install")]
    , [doSerial, "postinstall", staging, todo, lifecycle.newGroup("postinstall")]
    , npm.config.get("npat") && [doParallel, "test", staging, todo, lifecycle.newGroup("npat")]
    , [rimraf, staging]
    , [unlock, node_modules, ".staging"]
    , ! args.length && [actions.preinstall, idealTree.realpath, idealTree, toplifecycle.newGroup("preinstall:.")]
    , ! args.length && [actions.build, idealTree.realpath, idealTree, toplifecycle.newGroup("build:.")]
    , ! args.length && [actions.postinstall, idealTree.realpath, idealTree, toplifecycle.newGroup("postinstall:.")]
    , ! args.length && npm.config.get("npat") &&
                       [actions.test, idealTree.realpath, idealTree, toplifecycle.newGroup("npat:.")]
    , ! npm.config.get("production") && [actions.prepublish, idealTree.realpath, idealTree, toplifecycle.newGroup("prepublish")]
    ]
  chain(steps, cb)
}

function debugActions(log, name, actions, cb) {
  actions.forEach(function(A) {
    log.verbose(name, A.map(function(V){
      return (V && V.package) ? V.package.name + "@" + V.package.version : V
    }).join(" "))
  })
  cb()
}

function debugTracker(cb) {
  log.clearProgress()
  console.error(log.tracker.debug())
  log.showProgress()
  cb()
}

function debugTree(name,tree,cb) {
  log.verbose(name, prettify(tree).trim())
  log.verbose(name, require('util').inspect(tree))
  cb()
}

function prettify(tree) {
  var byName = function (A,B){
    return A.package.name > B.package.name ? 1 :
           A.package.name < B.package.name ? -1 : 0
  }
  return archy(
    { label: tree.package.name + "@" + tree.package.version
             + " " + tree.path
    , nodes: (tree.children || []).sort(byName).map(function P (c) {
        return {
          label: c.package.name + "@" + c.package.version
        , nodes: c.children.sort(byName).map(P)
        }
      })
    }, "", { unicode: npm.config.get("unicode") })
}
