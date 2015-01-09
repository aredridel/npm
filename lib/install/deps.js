"use strict"
var fetchPackageMetadata = require("../fetch-package-metadata.js")
var semver = require("semver")
var asyncMap = require("slide").asyncMap
var path = require("path")
var addParentToErrors = require("./add-parent-to-errors.js")

// The functions in this module mutate a dependency tree, adding items to them.


// Add a list of args to tree's top level dependencies
var loadArgs = exports.loadArgs = function (args, tree, log, cb) {
  asyncMap( args, function (spec, amcb) {
    addChild(spec, tree, log.newGroup("loadArgs"), asCbWithCb(loadDeps, amcb))
  }, cb)
}

// Chains on to a callback a call to one of the dependency loaders below
function asCbWithCb(depLoader,cb) {
  return function (er, child, log) {
    if (er) return cb(er)
    depLoader(child, log, cb)
  }
}

// Load any missing dependencies in the given tree
var loadDeps = exports.loadDeps = function (tree, log, cb) {
  if (!tree || !tree.package.dependencies) return cb()
  asyncMap(Object.keys(tree.package.dependencies), function (dep, amcb) {
    var version = tree.package.dependencies[dep]
    if (   tree.package.optionalDependencies
        && tree.package.optionalDependencies[dep]) {
      amcb = warnOnError(log, amcb)
    }
    addChild(dep + "@" + version, tree, log.newGroup("loadDep:"+dep), asCbWithCb(loadDeps, amcb))
  }, cb)
}

// Load development dependencies into the given tree
var loadDevDeps = exports.loadDevDeps = function (tree, log, cb) {
  if (!tree || !tree.package.devDependencies) return cb()
  asyncMap(Object.keys(tree.package.devDependencies), function (dep, amcb) {
    if (tree.package.dependencies && tree.package.dependencies[dep]) return amcb()
    var version = tree.package.devDependencies[dep];
    addChild(dep + "@" + version, tree, log.newGroup("loadDevDep:"+dep), function (er, child, log) {
      if (er) return amcb(er)
      var realParent = child.parent
      child.parent = null
      loadDeps(child, log, function (er) {
        if (er) return amcb(er)
        child.parent = realParent
        amcb.apply(null, arguments)
      })
    })
  }, cb)
}

function warnOnError(log, cb) {
  return function (er, result) {
    if (er) {
      log.warn("install", "Couldn't install optional dependency:", er.message)
      log.verbose("install", er.stack)
    }
    cb(null, result)
  }
}


var inflateShrinkwrap = exports.inflateShrinkwrap = function (tree, swdeps, cb) {
  if (!tree.children) tree.children = []
  asyncMap( Object.keys(swdeps), function (name, amcb) {
    var sw = swdeps[name]
    fetchPackageMetadata(name+"@"+sw.version, tree.path, function (er, pkg) {
      if (er) return cb(er)
      var child =
        { package:  pkg
        , children: []
        , loaded: true
        , requiredby: [tree]
        , path: path.join(tree.path, "node_modules", pkg.name)
        , realpath: path.resolve(tree.realpath, "node_modules", pkg.name)
        }
      tree.children.push(child)
      if (sw.dependencies) return inflateShrinkwrap(child, sw.dependencies, amcb)
      amcb()
    })
  }, cb)
}

// Resolve a module spec and add as a dependency to a tree
function addChild(spec, tree, log, cb) {
  cb = addParentToErrors(tree, cb)
  fetchPackageMetadata(spec, tree.path, log.newItem("fetchMetadata"), function (er, pkg) {
    if (er) return cb(er)

    var version = pkg.requested.spec
                ? pkg.requested.spec
                : pkg.version
    var child
    // If the requirement is already met by the tree...
    if (child = requirementExists(tree, pkg.name, version)) {
      if (!child.package.requested) {
        if (semver.satisfies(child.package.version, pkg.requested.spec)) {
          child.package.requested = pkg.requested
        }
        else {
          child.package.requested =
            { spec: child.package.version
            , type: "version"
            }
        }
      }
      if (child.package.requested.spec !== pkg.requested.spec) {
        child.package.requested.spec += " " + pkg.requested.spec
        child.package.requested.type = "range"
      }
      if (!child.requiredby) child.requiredby = []
      if (child.requiredby.filter(function (A){ return A === tree}).length==0) {
        child.requiredby.push(tree)
      }
      // if WE'VE processed this module before, just note our interest...
      if (child.loaded) {
        return cb()
      }
      // Otherwise recurse into it so we can make sure its depedencies are met
      else {
        child.loaded = true
        if (pkg.shrinkwrap && pkg.shrinkwrap.dependencies) {
          return inflateShrinkwrap(child, pkg.shrinkwrap.dependencies, cb)
        }
        return cb(null, child, log)
      }
    }
    // If we need to resolve the requirement ourselves...
    else {
      child =
        { package:  pkg
        , children: []
        , loaded: true
        , requiredby: [tree]
        }

      child.parent = earliestInstallable(tree, pkg.name, log) || tree
      child.parent.children.push(child)

      child.path = path.join(child.parent.path, "node_modules", pkg.name)
      child.realpath = path.resolve(child.parent.realpath, "node_modules", pkg.name)

      if (pkg.shrinkwrap && pkg.shrinkwrap.dependencies) {
        return inflateShrinkwrap(child, pkg.shrinkwrap.dependencies, cb)
      }

      cb(null, child, log)
    }
  })
}

// Return true if the requirement for name@version is already met by tree or
// one of its parents.
function requirementExists(tree, name, version) {
  var nameMatch = function (child) {
    return child.package.name === name
  }
  var versionMatch = function (child) {
    return semver.satisfies(child.package.version, version)
  }
  if (nameMatch(tree)) {
    // this *is* the module, but it doesn't match the version, so a
    // new copy will have to be installed
    return versionMatch(tree) ? tree : null
  }
  var matches = tree.children.filter(nameMatch)
  if (matches.length) {
    matches = matches.filter(versionMatch)
    // the module exists as a dependent, but the version doesn't match, so
    // a new copy will have to be installed above here
    if (matches.length) return matches[0]
    return null
  }
  if (!tree.parent) return null
  return requirementExists(tree.parent, name, version)
}

// Walk as far up the tree as we can to find a place to install name.
function earliestInstallable(tree, name, log) {
  var nameMatch = function (child) {
    return child.package.name === name
  }
  if (nameMatch(tree)) return tree
  var matches = tree.children.filter(nameMatch)
  if (matches.length) return null
  if (!tree.parent) return tree
  return (earliestInstallable(tree.parent, name, log) || tree)
}
