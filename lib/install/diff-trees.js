"use strict"
var finishLogAfterCb = require("./finish-log-after-cb.js")
var flattenTree = require("./flatten-tree.js")

function pkgAreEquiv (aa, bb) {
  if (aa.dist && bb.dist && aa.dist.shasum === bb.dist.shasum) return true
  if (aa.dist || bb.dist) return false
  if (aa.version === bb.version) return true
}

module.exports = function (oldTree, newTree, actions, log, cb) {
  cb = finishLogAfterCb(log.newItem(log.name), cb)
  oldTree = flattenTree(oldTree)
  newTree = flattenTree(newTree)
  Object.keys(oldTree).forEach(function (path) {
    if (newTree[path]) return
    actions.push(["remove", oldTree[path]])
  })
  Object.keys(newTree).forEach(function (path) {
    if (oldTree[path]) {
      if (pkgAreEquiv(oldTree[path].package, newTree[path].package)) return
      actions.push(["update", newTree[path]])
    }
    else {
      actions.push(["add", newTree[path]])
    }
  })
  cb()
}
