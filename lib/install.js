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
  mapToRegistry("-/short", npm.config, function (shortEr, shortUri) {
    if (shortEr) return cb(shortEr)

    registry.get(shortUri, null, function (getShortEr, pkgs) {
      if (getShortEr) return cb()
      if (!opts.partialWord) return cb(null, pkgs)

      var name = npa(opts.partialWord).name
      pkgs = pkgs.filter(function (p) {
        return p.indexOf(name) === 0
      })

      if (pkgs.length !== 1 && opts.partialWord === name) {
        return cb(null, pkgs)
      }

      mapToRegistry(pkgs[0], npm.config, function (fullEr, fullUri) {
        if (fullEr) return cb(fullEr)

        registry.get(fullUri, null, function (getFullEr, d) {
          if (getFullEr) return cb()
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

// system packages
var path = require("path")

// dependencies
var log = require("npmlog")
var readPackageTree = require("read-package-tree")
var chain = require("slide").chain
var archy = require("archy")
var mkdir = require("mkdirp")
var rimraf = require("rimraf")
var clone = require("clone")
var npa = require("npm-package-arg")

// npm internal utils
var npm = require("./npm.js")
var fetchPackageMetadata = require("./fetch-package-metadata.js")
var mapToRegistry = require("./utils/map-to-registry.js")
var locker = require("./utils/locker.js")
var lock = locker.lock
var unlock = locker.unlock

// install specific libraries
var inflateShrinkwrap = require("./install/deps.js").inflateShrinkwrap
var loadDeps = require("./install/deps.js").loadDeps
var loadDevDeps = require("./install/deps.js").loadDevDeps
var loadRequestedDeps = require("./install/deps.js").loadRequestedDeps
var diffTrees = require("./install/diff-trees.js")
var decomposeActions = require("./install/decompose-actions.js")
var validateTree = require("./install/validate-tree.js")
var saveRequested = require("./install/save.js").saveRequested
var getSaveType = require("./install/save.js").getSaveType
var actions = require("./install/actions.js").actions
var doSerial = require("./install/actions.js").doSerial
var doParallel = require("./install/actions.js").doParallel

function unlockCB (lockPath, name, cb) {
  return function (er1) {
    var args = arguments
    unlock(lockPath, name, function (er2) {
      if (er1) {
        if (er2) log.warning("unlock "+name, er2)
        return cb.apply(null, args)
      }
      if (er2) return cb(er2)
      cb.apply(null, args)
    })
  }
}

function install (args, cb) {
  // the /path/to/node_modules/..
  var where = path.resolve(npm.dir, "..")

  // internal api: install(where, what, cb)
  if (arguments.length === 3) {
    where = args
    args = [].concat(cb) // pass in [] to do default dep-install
    cb = arguments[2]
    log.verbose("install", "where, what", [where, args])
  }

  if (!npm.config.get("global")) {
    args = args.filter(function (a) {
      return path.resolve(a) !== where
    })
  }

  var node_modules = path.resolve(where, "node_modules")
  var staging = path.resolve(node_modules, ".staging")

  cb = unlockCB(node_modules, ".staging", cb)

  chain([
    [lock, node_modules, ".staging"],
    [rimraf, staging],

// glom into one thing:
    [readPackageTree, where],
    [readLocalPackageData, where, chain.last],
    [debugTree, "RPT", chain.last],
    [loadShrinkwrap, chain.last],

    [thenInstall, node_modules, staging, args, chain.last],
  ], cb)
}

function readLocalPackageData (where, currentTree, cb) {
  fetchPackageMetadata(".", where, function (er, pkg) {
    if (er && er.code !== "ENOPACKAGEJSON") return cb(er)
    currentTree.package = pkg || {}
    cb(null, currentTree)
  })
}

function loadShrinkwrap (currentTree, cb) {
  var idealTree = clone(currentTree)
  var next = function () { cb(null, {currentTree: currentTree, idealTree: idealTree}) }
  if (idealTree.package.shrinkwrap && idealTree.package.shrinkwrap.dependencies) {
    return inflateShrinkwrap(idealTree, idealTree.package.shrinkwrap.dependencies, next)
  }
  next()
}

function thenInstall (node_modules, staging, args, T, cb) {
  var currentTree = T.currentTree
  var idealTree = T.idealTree

  // If the user ran `npm install` we're expected to update to
  // the latest version, so ignore the versions in idealTree
  if (!idealTree.package.shrinkwrap && !args.length) {
    idealTree.children = []
  }

  var fast = log.newGroup("fast")
  var lifecycle = log.newGroup("lifecycle")
  var toplifecycle = lifecycle.newGroup("top")
  var move = log.newGroup("placement")

  var dev = npm.config.get("dev") || !npm.config.get("production")

  var todo = []
  var steps = []
  steps.push(
    [mkdir, staging],
    [loadDeps, idealTree, log.newGroup("loadDeps")], [debugTree, "loadDeps", idealTree])
  if (args.length) steps.push(
    [loadRequestedDeps, args, idealTree, log.newGroup("loadRequestedDeps", 2)], [debugTree, "loadRequestedDeps", idealTree])
  if (dev) steps.push(
    [loadDevDeps, idealTree, log.newGroup("loadDevDeps", 5)], [debugTree, "loadDevDeps", idealTree])
  steps.push(
    [validateTree, idealTree, log.newGroup("validateTree")],
    [diffTrees, currentTree, idealTree, todo, fast.newGroup("diffTrees")], [debugActions, log, "diffTrees", todo],
    [decomposeActions, todo, fast.newGroup("decomposeActions")], [debugActions, log, "decomposeActions", todo],

    [doParallel, "fetch", staging, todo, log.newGroup("fetch", 10)],
    [doParallel, "extract", staging, todo, log.newGroup("extract", 10)],
    [doParallel, "preinstall", staging, todo, lifecycle.newGroup("preinstall")],
    [doParallel, "remove", staging, todo, move.newGroup("remove")],
    [doSerial,   "finalize", staging, todo, move.newGroup("finalize")],
    [doParallel, "build", staging, todo, lifecycle.newGroup("build")],
    [doSerial,   "install", staging, todo, lifecycle.newGroup("install")],
    [doSerial,   "postinstall", staging, todo, lifecycle.newGroup("postinstall")])
  if (npm.config.get("npat")) steps.push(
    [doParallel, "test", staging, todo, lifecycle.newGroup("npat")])
  steps.push(
    [rimraf, staging],
    [unlock, node_modules, ".staging"])
  if (args.length) steps.push(
    [actions.preinstall, idealTree.realpath, idealTree, toplifecycle.newGroup("preinstall:.")],
    [actions.build, idealTree.realpath, idealTree, toplifecycle.newGroup("build:.")],
    [actions.postinstall, idealTree.realpath, idealTree, toplifecycle.newGroup("postinstall:.")])
  if (args.length && npm.config.get("npat")) steps.push(
    [actions.test, idealTree.realpath, idealTree, toplifecycle.newGroup("npat:.")])
  if (!npm.config.get("production")) steps.push(
    [actions.prepublish, idealTree.realpath, idealTree, toplifecycle.newGroup("prepublish")])
// glom ^^
  if (saveToDependencies) steps.push(
    [saveRequested, idealTree])
  chain(steps, cb)
}

function debugActions (log, name, actionsToLog, cb) {
  actionsToLog.forEach(function (action) {
    log.silly(name, action.map(function (value) {
      return (value && value.package) ? value.package.name + "@" + value.package.version : value
    }).join(" "))
  })
  cb()
}

function debugTree (name,tree,cb) {
  log.silly(name, prettify(tree).trim())
  cb()
}

function prettify (tree) {
  function byName (aa,bb) {
    return aa.package.name.localeCompare(bb)
  }
  return archy( {
    label: tree.package.name + "@" + tree.package.version
           + " " + tree.path,
    nodes: (tree.children || []).sort(byName).map(function expandChild (child) {
      return {
        label: child.package.name + "@" + child.package.version,
        nodes: child.children.sort(byName).map(expandChild)
      }
    })
  }, "", { unicode: npm.config.get("unicode") })
}
