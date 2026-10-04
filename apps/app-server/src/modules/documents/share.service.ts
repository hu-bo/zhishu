import type { Principal } from "../identity/identity.types.js";
import { DomainError } from "../../shared/domain-error.js";
import type { AssetObjectStorage } from "../assets/asset-storage.js";
import type { CatalogService } from "./catalog.service.js";
import type { CreateShareInput } from "./share.schema.js";
import type { ShareRepository } from "./share.repository.js";

export type ShareServiceOptions = {
  accessUrlTtlSeconds: number;
};

export class ShareService {
  constructor(
    private readonly shares: ShareRepository,
    private readonly catalogs: CatalogService,
    private readonly storage: AssetObjectStorage | null,
    private readonly options: ShareServiceOptions,
  ) {}

  create(principal: Principal, documentId: string, input: CreateShareInput) {
    return this.shares.create(principal, documentId, input);
  }

  list(principal: Principal, documentId: string) {
    return this.shares.list(principal, documentId);
  }

  revoke(principal: Principal, documentId: string, shareId: string) {
    return this.shares.revoke(principal, documentId, shareId);
  }

  publicDetail(shareId: string) {
    return this.shares.loadForPublic(shareId);
  }

  publicContent(shareId: string) {
    return this.shares.contentForPublic(shareId);
  }

  async publicAssetAccess(shareId: string, assetId: string) {
    if (!this.storage)
      throw new DomainError("SERVICE_UNAVAILABLE", "Private asset storage is not configured");
    const asset = await this.shares.assetForPublic(shareId, assetId);
    const url = await this.storage.createReadUrl({
      objectKey: asset.objectKey,
      fileName: asset.fileName,
      mediaType: asset.mediaType,
      expiresIn: this.options.accessUrlTtlSeconds,
    });
    return {
      url,
      expiresAt: new Date(Date.now() + this.options.accessUrlTtlSeconds * 1_000).toISOString(),
    };
  }

  async join(principal: Principal, shareId: string) {
    const result = await this.shares.join(principal, shareId);
    // After a successful join the caller always has read access, so locate cannot 404 here.
    const location = await this.catalogs.locate(principal, result.documentId);
    return { ...location, joined: result.joined };
  }
}
