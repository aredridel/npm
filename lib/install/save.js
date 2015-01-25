"use strict"
var fs = require("fs")
var path = require("path")
var writeFileAtomic = require("write-file-atomic")
var log = require("npmlog")
var semver = require("semver")
var npm = require("../npm.js")
var sortedObject = require("sorted-object")
var iferr = require("iferr")

// if the -S|--save option is specified, then write installed packages
// as dependencies to a package.json file.

exports.saveRequested = function (tree, andReturn) {
  savePackageJson(tree, warnErrors(andSaveShrinkwrap))
  function andSaveShrinkwrap () {
    saveShrinkwrap(tree, warnErrors(andReturn))
  }
}

function warnErrors (cb) {
  return function (er) {
    if (er) log.warn("error", er.message)
    arguments[0] = null
    cb.apply(null, arguments)
  }
}

function savePackageJson (tree, next) {
  var saveBundle = npm.config.get("save-bundle")

  // each item in the tree is a top-level thing that should be saved
  // to the package.json file.
  // The relevant tree shape is { <folder>: {what:<pkg>} }
  var saveTarget = path.resolve(tree.realpath, "package.json")
  // don't use readJson, because we don't want to do all the other
  // tricky npm-specific stuff that's in there.
  fs.readFile(saveTarget, iferr(next, function (data) {
    try {
      data = JSON.parse(data.toString("utf8"))
    } catch (ex) {
      return next(ex)
    }

    // If we're saving bundled deps, normalize the key before we start
    if (saveBundle) {
      var bundle = data.bundleDependencies || data.bundledDependencies
      delete data.bundledDependencies
      if (!Array.isArray(bundle)) bundle = []
      data.bundleDependencies = bundle.sort()
    }

    var things = getThingsToSave(tree)
    var savingTo = {}
    things.forEach(function(pkg) { savingTo[pkg.save] = true })

    Object.keys(savingTo).forEach(function (save) {
      if (!data[save]) data[save] = {}
    })

    log.verbose("saving", things)
    things.forEach(function (pkg) {
      data[pkg.save][pkg.name] = pkg.spec
      if (saveBundle) {
        var ii = bundle.indexOf(pkg.name)
        if (ii === -1) bundle.push(pkg.name)
        data.bundleDependencies = bundle.sort()
      }
    })

    Object.keys(savingTo).forEach(function (save) {
      data[save] = sortedObject(data[save])
    })

    data = JSON.stringify(data, null, 2) + "\n"
    writeFileAtomic(saveTarget, data, next)
  }))
}


exports.getSaveType = function (args) {
  var nothingToSave = !args.length
  var globalInstall = npm.config.get("global")
  var noSaveFlags   = !npm.config.get("save")
                    && !npm.config.get("save-dev")
                    && !npm.config.get("save-optional")
  if (nothingToSave || globalInstall || noSaveFlags)  return

  if (npm.config.get("save-optional")) return "optionalDependencies"
  else if (npm.config.get("save-dev")) return "devDependencies"
  else                                 return "dependencies"
}

function computeVersionSpec (child) {
  var spec = child.requested ? child.requested.spec : child.package.version
  var rangeDescriptor = ""
  if (semver.valid(spec, true) &&
      semver.gte(spec, "0.1.0", true) &&
      !npm.config.get("save-exact")) {
    rangeDescriptor = npm.config.get("save-prefix")
  }
  return rangeDescriptor + spec
}

function getThingsToSave (tree) {
  var toSave = tree.children
    .filter(function(child){ return child.save })
    .map(function(child) { return {
        name: child.package.name,
        spec: computeVersionSpec(child),
        save: child.save
      }
    })
  return toSave
}

function saveShrinkwrap (tree, next) {
  return next()
  var saveTarget = path.resolve(tree.realpath, "npm-shrinkwrap.json")
  fs.readFile(saveTarget, function (er, data) {
    if (er) return next(er.code === "ENOENT" ? null : er)
    try {
      data = JSON.parse(data.toString("utf8"))
    } catch (ex) {
      return next(ex)
    }
    var things = getThingsToSave(tree)
  })
}
