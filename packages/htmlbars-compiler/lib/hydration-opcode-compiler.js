import TemplateVisitor from "./template-visitor";
import { processOpcodes } from "./utils";
import { forEach } from "../htmlbars-util/array-utils";
import { isHelper } from "../htmlbars-syntax/utils";

function unwrapMustache(mustache) {
  if (isHelper(mustache.sexpr)) {
    return mustache.sexpr;
  } else {
    return mustache.sexpr.path;
  }
}

function detectIsElementChecked(element){
  for (var i=0, len=element.attributes.length;i<len;i++) {
    if (element.attributes[i].name === 'checked') {
      return true;
    }
  }
  return false;
}

function HydrationOpcodeCompiler() {
  this.opcodes = [];
  this.paths = [];
  this.templateId = 0;
  this.currentDOMChildIndex = 0;
  this.morphs = [];
  this.morphNum = 0;
  this.element = null;
  this.elementNum = -1;
}

export default HydrationOpcodeCompiler;

HydrationOpcodeCompiler.prototype.compile = function(ast) {
  var templateVisitor = new TemplateVisitor();
  templateVisitor.visit(ast);

  processOpcodes(this, templateVisitor.actions);

  return this.opcodes;
};

HydrationOpcodeCompiler.prototype.accept = function(node) {
  this[node.type](node);
};

HydrationOpcodeCompiler.prototype.opcode = function(type) {
  var params = [].slice.call(arguments, 1);
  this.opcodes.push([type, params]);
};

HydrationOpcodeCompiler.prototype.startProgram = function(program, c, blankChildTextNodes) {
  this.opcodes.length = 0;
  this.paths.length = 0;
  this.morphs.length = 0;
  this.templateId = 0;
  this.currentDOMChildIndex = -1;
  this.morphNum = 0;

  var blockParams = program.blockParams || [];

  for (var i = 0; i < blockParams.length; i++) {
    this.opcode('printSetHook', blockParams[i], i);
  }

  if (blankChildTextNodes.length > 0) {
    this.opcode('repairClonedNode', blankChildTextNodes);
  }
};

HydrationOpcodeCompiler.prototype.endProgram = function(/* program */) {
  distributeMorphs(this.morphs, this.opcodes);
};

HydrationOpcodeCompiler.prototype.text = function(/* string, pos, len */) {
  ++this.currentDOMChildIndex;
};

HydrationOpcodeCompiler.prototype.comment = function(/* string, pos, len */) {
  ++this.currentDOMChildIndex;
};

HydrationOpcodeCompiler.prototype.openElement = function(element, pos, len, isSingleRoot, mustacheCount, blankChildTextNodes) {
  distributeMorphs(this.morphs, this.opcodes);
  ++this.currentDOMChildIndex;

  this.element = this.currentDOMChildIndex;

  if (!isSingleRoot) {
    this.opcode('consumeParent', this.currentDOMChildIndex);

    // If our parent reference will be used more than once, cache its reference.
    if (mustacheCount > 1) {
      this.opcode('shareElement', ++this.elementNum);
      this.element = null; // Set element to null so we don't cache it twice
    }
  }
  var isElementChecked = detectIsElementChecked(element);
  if (blankChildTextNodes.length > 0 || isElementChecked) {
    this.opcode( 'repairClonedNode',
                 blankChildTextNodes,
                 isElementChecked );
  }

  this.paths.push(this.currentDOMChildIndex);
  this.currentDOMChildIndex = -1;

  forEach(element.attributes, this.attribute, this);
  forEach(element.helpers, this.elementHelper, this);
};

HydrationOpcodeCompiler.prototype.closeElement = function(element, pos, len, isSingleRoot) {
  distributeMorphs(this.morphs, this.opcodes);
  if (!isSingleRoot) { this.opcode('popParent'); }
  this.currentDOMChildIndex = this.paths.pop();
};

HydrationOpcodeCompiler.prototype.block = function(block, childIndex, childrenLength) {
  var sexpr = block.sexpr;
  var program = block.program || {};
  var blockParams = program.blockParams || [];

  var currentDOMChildIndex = this.currentDOMChildIndex;
  var start = (currentDOMChildIndex < 0) ? null : currentDOMChildIndex;
  var end = (childIndex === childrenLength - 1) ? null : currentDOMChildIndex + 1;

  var morphNum = this.morphNum++;
  this.morphs.push([morphNum, this.paths.slice(), start, end, true]);

  var templateId = this.templateId++;
  var inverseId = block.inverse === null ? null : this.templateId++;

  prepareSexpr(this, sexpr);
  this.opcode('printContentHookForBlockHelper', morphNum, templateId, inverseId, blockParams.length);
};

HydrationOpcodeCompiler.prototype.component = function(component, childIndex, childrenLength) {
  var currentDOMChildIndex = this.currentDOMChildIndex;
  var program = component.program || {};
  var blockParams = program.blockParams || [];

  var start = (currentDOMChildIndex < 0 ? null : currentDOMChildIndex),
      end = (childIndex === childrenLength - 1 ? null : currentDOMChildIndex + 1);

  var morphNum = this.morphNum++;
  this.morphs.push([morphNum, this.paths.slice(), start, end]);

  var attrs = component.attributes;
  for (var i = attrs.length - 1; i >= 0; i--) {
    var name = attrs[i].name;
    var value = attrs[i].value;

    // TODO: Introduce context specific AST nodes to avoid switching here.
    if (value.type === 'TextNode') {
      this.opcode('pushLiteral', value.chars);
    } else if (value.type === 'MustacheStatement') {
      this.accept(unwrapMustache(value));
    } else if (value.type === 'ConcatStatement') {
      prepareParams(this, value.parts);
      this.opcode('pushConcatHook');
    }

    this.opcode('pushLiteral', name);
  }

  this.opcode('prepareObject', attrs.length);
  this.opcode('pushLiteral', component.tag);
  this.opcode('printComponentHook', morphNum, this.templateId++, blockParams.length);
};

HydrationOpcodeCompiler.prototype.attribute = function(attr) {
  var value = attr.value;
  var quoted;
  
  // TODO: Introduce context specific AST nodes to avoid switching here.
  if (value.type === 'TextNode') {
    return;
  } else if (value.type === 'MustacheStatement') {
    quoted = false;
    this.accept(unwrapMustache(value));
  } else if (value.type === 'ConcatStatement') {
    quoted = true;
    prepareParams(this, value.parts);
    this.opcode('pushConcatHook');
  }

  this.opcode('pushLiteral', attr.name);

  if (this.element !== null) {
    this.opcode('shareElement', ++this.elementNum);
    this.element = null;
  }

  this.opcode('printAttributeHook', this.elementNum, value.type === 'ConcatStatement');
};

HydrationOpcodeCompiler.prototype.elementHelper = function(sexpr) {
  prepareSexpr(this, sexpr);

  // If we have a helper in a node, and this element has not been cached, cache it
  if (this.element !== null) {
    this.opcode('shareElement', ++this.elementNum);
    this.element = null; // Reset element so we don't cache it more than once
  }

  this.opcode('printElementHook', this.elementNum);
};

HydrationOpcodeCompiler.prototype.mustache = function(mustache, childIndex, childrenLength) {
  var sexpr = mustache.sexpr;
  var currentDOMChildIndex = this.currentDOMChildIndex;

  var start = currentDOMChildIndex,
      end = (childIndex === childrenLength - 1 ? -1 : currentDOMChildIndex + 1);

  var morphNum = this.morphNum++;
  this.morphs.push([morphNum, this.paths.slice(), start, end, mustache.escaped]);

  if (isHelper(sexpr)) {
    prepareSexpr(this, sexpr);
    this.opcode('printContentHookForInlineHelper', morphNum);
  } else {
    preparePath(this, sexpr.path);
    this.opcode('printContentHookForAmbiguous', morphNum);
  }
};

HydrationOpcodeCompiler.prototype.SubExpression = function(sexpr) {
  prepareSexpr(this, sexpr);
  this.opcode('pushSexprHook');
};

HydrationOpcodeCompiler.prototype.PathExpression = function(path) {
  this.opcode('pushGetHook', path.original);
};

HydrationOpcodeCompiler.prototype.StringLiteral = function(node) {
  this.opcode('pushLiteral', node.value);
};

HydrationOpcodeCompiler.prototype.BooleanLiteral = function(node) {
  this.opcode('pushLiteral', node.value);
};

HydrationOpcodeCompiler.prototype.NumberLiteral = function(node) {
  this.opcode('pushLiteral', node.value);
};

function preparePath(compiler, path) {
  compiler.opcode('pushLiteral', path.original);
}

function prepareParams(compiler, params) {
  for (var i = params.length - 1; i >= 0; i--) {
    var param = params[i];
    compiler[param.type](param);
  }

  compiler.opcode('prepareArray', params.length);
}

function prepareHash(compiler, hash) {
  var pairs = hash.pairs;

  for (var i = pairs.length - 1; i >= 0; i--) {
    var key = pairs[i].key;
    var value = pairs[i].value;

    compiler[value.type](value);
    compiler.opcode('pushLiteral', key);
  }

  compiler.opcode('prepareObject', pairs.length);
}

function prepareSexpr(compiler, sexpr) {
  prepareHash(compiler, sexpr.hash);
  prepareParams(compiler, sexpr.params);
  preparePath(compiler, sexpr.path);
}

function distributeMorphs(morphs, opcodes) {
  if (morphs.length === 0) {
    return;
  }

  // Splice morphs after the most recent shareParent/consumeParent.
  var o;
  for (o = opcodes.length - 1; o >= 0; --o) {
    var opcode = opcodes[o][0];
    if (opcode === 'shareElement' || opcode === 'consumeParent'  || opcode === 'popParent') {
      break;
    }
  }

  var spliceArgs = [o + 1, 0];
  for (var i = 0; i < morphs.length; ++i) {
    spliceArgs.push(['createMorph', morphs[i].slice()]);
  }
  opcodes.splice.apply(opcodes, spliceArgs);
  morphs.length = 0;
}
