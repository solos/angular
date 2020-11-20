/**
 * @license
 * Copyright Google LLC All Rights Reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://angular.io/license
 */
import * as ts from 'typescript';

import {absoluteFromSourceFile, AbsoluteFsPath} from '../../file_system';
import {ComponentResolutionRegistry} from '../../incremental/api';
import {DirectiveMeta, NgModuleMeta, PipeMeta} from '../../metadata';
import {ClassDeclaration} from '../../reflection';
import {getSourceFile} from '../../util/src/typescript';

import {SemanticSymbol, SymbolResolver} from './api';
import {ComponentSymbol, DirectiveSymbol, NgModuleSymbol, PipeSymbol} from './symbols';

export interface SemanticDependencyResult {
  /**
   * The files that need to be re-emitted.
   */
  needsEmit: Set<AbsoluteFsPath>;

  /**
   * The newly built graph that represents the current compilation.
   */
  newGraph: SemanticDepGraph;
}

/**
 * Represents a declaration for which no semantic symbol has been registered. For example,
 * declarations from external dependencies have not been explicitly registered and are represented
 * by this symbol. This allows the unresolved symbol to still be compared to a symbol from a prior
 * compilation.
 */
class UnresolvedSymbol extends SemanticSymbol {
  isPublicApiAffected(): never {
    throw new Error('Invalid state: unresolved symbols should not be diffed');
  }

  distribute(): void {}
}

/**
 * The semantic dependency graph of a single compilation.
 */
export class SemanticDepGraph {
  readonly files = new Map<AbsoluteFsPath, Map<string, SemanticSymbol>>();
  readonly symbolByDecl = new Map<ClassDeclaration, SemanticSymbol>();

  /**
   * Registers a symbol for the provided declaration as created by the factory function. The symbol
   * is given a unique identifier if possible, such that its equivalent symbol can be obtained from
   * a prior graph even if its declaration node has changed across rebuilds. Symbols without an
   * identifier are only able to find themselves in a prior graph if their declaration node is
   * identical.
   *
   * @param decl
   * @param factory
   */
  registerSymbol(
      decl: ClassDeclaration,
      factory: (path: AbsoluteFsPath, decl: ClassDeclaration, identifier: string|null) =>
          SemanticSymbol): void {
    const path = absoluteFromSourceFile(getSourceFile(decl));
    const identifier = getSymbolIdentifier(decl);

    const symbol = factory(path, decl, identifier);
    this.symbolByDecl.set(decl, symbol);

    if (symbol.identifier !== null) {
      // If the symbol has a unique identifier, record it in the file that declares it. This enables
      // the symbol to be requested by its unique name.
      if (!this.files.has(path)) {
        this.files.set(path, new Map<string, SemanticSymbol>());
      }
      this.files.get(path)!.set(symbol.identifier, symbol);
    }
  }

  /**
   * Attempts to resolve a symbol in this graph that represents the given symbol from another graph.
   * If no matching symbol could be found, null is returned.
   *
   * @param symbol The symbol from another graph for which its equivalent in this graph should be
   * found.
   */
  getEquivalentSymbol(symbol: SemanticSymbol): SemanticSymbol|null {
    // First lookup the symbol by its declaration. It is typical for the declaration to not have
    // changed across rebuilds, so this is likely to find the symbol. Using the declaration also
    // allows to diff symbols for which no unique identifier could be determined.
    let previousSymbol = this.getSymbolByDecl(symbol.decl);
    if (previousSymbol === null && symbol.identifier !== null) {
      // The declaration could not be resolved to a symbol in a prior compilation, which may
      // happen because the file containing the declaration has changed. In that case we want to
      // lookup the symbol based on its unique identifier, as that allows us to still compare the
      // changed declaration to the prior compilation.
      previousSymbol = this.getSymbolByName(symbol.path, symbol.identifier);
    }

    return previousSymbol;
  }

  /**
   * Attempts to find the symbol by its identifier.
   */
  private getSymbolByName(path: AbsoluteFsPath, identifier: string): SemanticSymbol|null {
    if (!this.files.has(path)) {
      return null;
    }
    const file = this.files.get(path)!;
    if (!file.has(identifier)) {
      return null;
    }
    return file.get(identifier)!;
  }

  /**
   * Attempts to resolve the declaration to its semantic symbol.
   */
  getSymbolByDecl(decl: ClassDeclaration): SemanticSymbol|null {
    if (!this.symbolByDecl.has(decl)) {
      return null;
    }
    return this.symbolByDecl.get(decl)!;
  }
}

function getSymbolIdentifier(decl: ClassDeclaration): string|null {
  if (!ts.isSourceFile(decl.parent)) {
    return null;
  }

  // If this is a top-level class declaration, the class name is used as unique identifier.
  // Other scenarios are currently not supported and causes the symbol not to be identified
  // across rebuilds, unless the declaration node has not changed.
  return decl.name.text;
}

/**
 * Implements the logic to go from a previous dependency graph to a new one, along with information
 * on which files have been affected.
 */
export class SemanticDepGraphUpdater implements ComponentResolutionRegistry {
  private readonly newGraph = new SemanticDepGraph();

  /**
   * Contains unresolved symbols that were created for declarations for which there was no symbol
   * registered, which happens for e.g. external declarations.
   */
  private readonly unresolvedSymbols = new Map<ClassDeclaration, UnresolvedSymbol>();

  constructor(
      /**
       * The semantic dependency graph of the most recently succeeded compilation, or null if this
       * is the initial build.
       */
      private priorGraph: SemanticDepGraph|null) {}

  addNgModule(metadata: NgModuleMeta): void {
    this.newGraph.registerSymbol(metadata.ref.node, (path, decl, identifier) => {
      return new NgModuleSymbol(
          path, decl, identifier, metadata.declarations.map(decl => decl.node));
    });
  }

  addDirective(metadata: DirectiveMeta): void {
    this.newGraph.registerSymbol(metadata.ref.node, (path, decl, identifier) => {
      if (metadata.isComponent) {
        return new ComponentSymbol(
            path, decl, identifier, metadata.selector, metadata.inputs.propertyNames,
            metadata.outputs.propertyNames, metadata.exportAs);
      }
      return new DirectiveSymbol(
          path, decl, identifier, metadata.selector, metadata.inputs.propertyNames,
          metadata.outputs.propertyNames, metadata.exportAs);
    });
  }

  addPipe(metadata: PipeMeta): void {
    this.newGraph.registerSymbol(metadata.ref.node, (path, decl, identifier) => {
      return new PipeSymbol(path, decl, identifier, metadata.name);
    });
  }

  register(
      component: ClassDeclaration, usedDirectives: ClassDeclaration[],
      usedPipes: ClassDeclaration[], isRemotelyScoped: boolean): void {
    const symbol = this.newGraph.getSymbolByDecl(component);

    // The fact that the component is being registered requires that its analysis data has been
    // recorded as a symbol, so it's an error for `symbol` to be missing or not to be a
    // `ComponentSymbol`.
    if (symbol === null) {
      throw new Error(
          `Illegal state: no symbol information available for component ${component.name.text}`);
    } else if (!(symbol instanceof ComponentSymbol)) {
      throw new Error(`Illegal state: symbol information should be for a component, got ${
          symbol.constructor.name} for ${component.name.text}`);
    }

    symbol.usedDirectives = usedDirectives.map(dir => this.getSymbol(dir));
    symbol.usedPipes = usedPipes.map(pipe => this.getSymbol(pipe));
    symbol.isRemotelyScoped = isRemotelyScoped;
  }

  /**
   * Takes all facts that have been gathered to create a new semantic dependency graph. In this
   * process, the semantic impact of the changes is determined which results in a set of files that
   * need to be emitted and/or type-checked.
   */
  finalize(): SemanticDependencyResult {
    this.connect();

    if (this.priorGraph === null) {
      // If no prior dependency graph is available then this was the initial build, in which case
      // we don't need to determine the semantic impact as everything is already considered
      // logically changed.
      return {
        needsEmit: new Set<AbsoluteFsPath>(),
        newGraph: this.newGraph,
      };
    }

    const needsEmit = this.determineInvalidatedFiles(this.priorGraph);
    return {
      needsEmit,
      newGraph: this.newGraph,
    };
  }

  /**
   * Implements the first phase of the semantic invalidation algorithm by connecting all symbols
   * together.
   */
  private connect(): void {
    const symbolResolver: SymbolResolver = decl => this.getSymbol(decl);

    for (const symbol of this.newGraph.symbolByDecl.values()) {
      if (symbol.connect === undefined) {
        continue;
      }

      symbol.connect(symbolResolver);
    }
  }

  private determineInvalidatedFiles(priorGraph: SemanticDepGraph): Set<AbsoluteFsPath> {
    const isPublicApiAffected = new Set<SemanticSymbol>();

    // The first phase is to collect all symbols which have their public API affected. Any symbols
    // that cannot be matched up with a symbol from the prior graph are considered affected.
    for (const symbol of this.newGraph.symbolByDecl.values()) {
      const previousSymbol = priorGraph.getEquivalentSymbol(symbol);
      if (previousSymbol === null || symbol.isPublicApiAffected(previousSymbol)) {
        isPublicApiAffected.add(symbol);
      }
    }

    // The second phase is to find all symbols for which the emit result is affected, either because
    // their used declarations have changed or any of those used declarations has had its public API
    // affected as determined in the first phase.
    const needsEmit = new Set<AbsoluteFsPath>();
    for (const symbol of this.newGraph.symbolByDecl.values()) {
      if (symbol.isEmitAffected === undefined) {
        continue;
      }

      const previousSymbol = priorGraph.getEquivalentSymbol(symbol);
      if (previousSymbol === null || symbol.isEmitAffected(previousSymbol, isPublicApiAffected)) {
        needsEmit.add(symbol.path);
      }
    }

    return needsEmit;
  }

  private getSymbol(decl: ClassDeclaration): SemanticSymbol {
    const symbol = this.newGraph.getSymbolByDecl(decl);
    if (symbol === null) {
      // No symbol has been recorded for the provided declaration, which would be the case if the
      // declaration is external. Return an unresolved symbol in that case, to allow the external
      // declaration to be compared to a prior compilation.
      return this.getUnresolvedSymbol(decl);
    }
    return symbol;
  }

  /**
   * Gets or creates an `UnresolvedSymbol` for the provided class declaration.
   */
  private getUnresolvedSymbol(decl: ClassDeclaration): UnresolvedSymbol {
    if (this.unresolvedSymbols.has(decl)) {
      return this.unresolvedSymbols.get(decl)!;
    }

    const path = absoluteFromSourceFile(getSourceFile(decl));
    const identifier = getSymbolIdentifier(decl);
    const symbol = new UnresolvedSymbol(path, decl, identifier);
    this.unresolvedSymbols.set(decl, symbol);
    return symbol;
  }
}
