CREATE TABLE "ProductImage" (
    "id" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL,
    "productId" TEXT NOT NULL,

    CONSTRAINT "ProductImage_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ProductImage_productId_sortOrder_key"
ON "ProductImage"("productId", "sortOrder");

CREATE INDEX "ProductImage_productId_idx"
ON "ProductImage"("productId");

ALTER TABLE "ProductImage"
ADD CONSTRAINT "ProductImage_productId_fkey"
FOREIGN KEY ("productId") REFERENCES "Product"("id")
ON DELETE CASCADE ON UPDATE CASCADE;
