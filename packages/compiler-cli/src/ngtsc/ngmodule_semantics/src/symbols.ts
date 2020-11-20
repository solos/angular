/**
 * @license
 * Copyright Google LLC All Rights Reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://angular.io/license
 */
import {AbsoluteFsPath} from '../../file_system';
import {ClassDeclaration} from '../../reflection';

import {SemanticSymbol, SymbolResolver} from './api';
import {isArrayEqual, isSymbolEqual} from './util';

/**
 * Represents an Angular pipe.
 */
export class PipeSymbol extends SemanticSymbol {
  constructor(
      path: AbsoluteFsPath, decl: ClassDeclaration, symbolName: string|null,
      public readonly name: string) {
    super(path, decl, symbolName);
  }

  isPublicApiAffected(previousSymbol: SemanticSymbol): boolean {
    if (!(previousSymbol instanceof PipeSymbol)) {
      return true;
    }

    return this.name !== previousSymbol.name;
  }
}

/**
 * Represents an Angular directive. Components are represented by `ComponentSymbol`, which inherits
 * from this symbol.
 */
export class DirectiveSymbol extends SemanticSymbol {
  constructor(
      path: AbsoluteFsPath, decl: ClassDeclaration, symbolName: string|null,
      public readonly selector: string|null, public readonly inputs: string[],
      public readonly outputs: string[], public readonly exportAs: string[]|null) {
    super(path, decl, symbolName);
  }

  isPublicApiAffected(previousSymbol: SemanticSymbol): boolean {
    // Note: since components and directives have exactly the same items contributing to their
    // public API, it is okay for a directive to change into a component and vice versa without
    // the API being affected.
    if (!(previousSymbol instanceof DirectiveSymbol)) {
      return true;
    }

    // Directives and components have a public API of:
    //  1. Their selector.
    //  2. The binding names of their inputs and outputs; a change in ordering is also considered
    //     to be a change in public API.
    //  3. The list of exportAs names and its ordering.
    return this.selector !== previousSymbol.selector ||
        !isArrayEqual(this.inputs, previousSymbol.inputs) ||
        !isArrayEqual(this.outputs, previousSymbol.outputs) ||
        !isArrayEqual(this.exportAs, previousSymbol.exportAs);
  }
}

/**
 * Represents an Angular component.
 */
export class ComponentSymbol extends DirectiveSymbol {
  usedDirectives: SemanticSymbol[] = [];
  usedPipes: SemanticSymbol[] = [];
  isRemotelyScoped = false;

  isEmitAffected(previousSymbol: SemanticSymbol, publicApiAffected: Set<SemanticSymbol>): boolean {
    if (!(previousSymbol instanceof ComponentSymbol)) {
      return true;
    }

    // Create an equality function that considers symbols equal if they represent the same
    // declaration, but only if the symbol in the current compilation does not have its public API
    // affected.
    const isSymbolAffected = (current: SemanticSymbol, previous: SemanticSymbol) =>
        isSymbolEqual(current, previous) && !publicApiAffected.has(current);

    // The emit of a component is affected if either of the following is true:
    //  1. The component used to be remotely scoped but no longer is, or vice versa.
    //  2. The list of used directives has changed or any of those directives have had their public
    //     API changed. If the used directives have been reordered but not otherwise affected then
    //     the component must still be re-emitted, as this may affect directive instantiation order.
    //  3. The list of used pipes has changed, or any of those pipes have had their public API
    //     changed.
    return this.isRemotelyScoped !== previousSymbol.isRemotelyScoped ||
        !isArrayEqual(this.usedDirectives, previousSymbol.usedDirectives, isSymbolAffected) ||
        !isArrayEqual(this.usedPipes, previousSymbol.usedPipes, isSymbolAffected);
  }
}

/**
 * Represents an Angular NgModule.
 */
export class NgModuleSymbol extends SemanticSymbol {
  private hasRemoteScopes = false;

  constructor(
      path: AbsoluteFsPath, decl: ClassDeclaration, symbolName: string|null,
      private readonly rawDeclarations: ClassDeclaration[]) {
    super(path, decl, symbolName);
  }

  connect(resolve: SymbolResolver): void {
    const declarations = this.rawDeclarations.map(resolve);

    // An NgModule has remote scopes if any of its declared components is remotely scoped.
    this.hasRemoteScopes =
        declarations.some(symbol => symbol instanceof ComponentSymbol && symbol.isRemotelyScoped);
  }

  isPublicApiAffected(previousSymbol: SemanticSymbol): boolean {
    if (!(previousSymbol instanceof NgModuleSymbol)) {
      return true;
    }

    // NgModules don't have a public API that could affect emit of Angular decorated classes.
    return false;
  }

  isEmitAffected(previousSymbol: SemanticSymbol): boolean {
    if (!(previousSymbol instanceof NgModuleSymbol)) {
      return true;
    }

    // The NgModule needs to be re-emitted if it does no longer have any remote scopes, or vice
    // versa.
    return this.hasRemoteScopes !== previousSymbol.hasRemoteScopes;
  }
}
