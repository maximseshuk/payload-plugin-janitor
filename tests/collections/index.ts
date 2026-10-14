import type { CollectionConfig, GlobalConfig } from 'payload'

export const Users: CollectionConfig = {
  slug: 'users',
  auth: true,
  fields: [],
  versions: false,
}

export const Media: CollectionConfig = {
  slug: 'media',
  fields: [
    { name: 'alt', type: 'text' },
    { name: 'thumbnail', type: 'upload', relationTo: 'media' },
  ],
  upload: { disableLocalStorage: true, staticDir: 'media' },
  versions: false,
}

export const Files: CollectionConfig = {
  slug: 'files',
  fields: [{ name: 'title', type: 'text' }],
  trash: true,
  upload: { disableLocalStorage: true, staticDir: 'files' },
  versions: false,
}

export const Simple: CollectionConfig = {
  slug: 'simple',
  access: { read: () => ({ title: { not_equals: 'hidden from the user' } }) },
  admin: { useAsTitle: 'title' },
  fields: [
    { name: 'title', type: 'text' },
    { name: 'summary', type: 'textarea' },
    { name: 'weight', type: 'number' },
    { name: 'contact', type: 'email' },
    { name: 'snippet', type: 'code' },
    { name: 'publishedOn', type: 'date' },
    { name: 'featured', type: 'checkbox' },
    { name: 'status', type: 'select', options: ['draft', 'live'] },
    { name: 'size', type: 'radio', options: ['s', 'm', 'l'] },
    { name: 'image', type: 'upload', relationTo: 'media' },
  ],
  versions: false,
}

export const Locked: CollectionConfig = {
  slug: 'locked',
  access: { read: () => false },
  fields: [{ name: 'image', type: 'upload', relationTo: 'media' }],
  versions: false,
}

export const Notices: CollectionConfig = {
  slug: 'notices',
  access: { read: () => true },
  admin: { useAsTitle: 'title' },
  fields: [
    { name: 'title', type: 'text', access: { read: ({ req }) => Boolean(req.user) } },
    { name: 'image', type: 'upload', relationTo: 'media' },
  ],
  versions: false,
}

export const Posts: CollectionConfig = {
  slug: 'posts',
  admin: { useAsTitle: 'title' },
  trash: true,
  fields: [
    { name: 'title', type: 'text' },
    {
      type: 'row',
      fields: [
        { name: 'hero', type: 'upload', relationTo: 'media' },
        { name: 'gallery', type: 'upload', hasMany: true, relationTo: 'media' },
      ],
    },
    { name: 'related', type: 'relationship', relationTo: ['media', 'tags'] },
    { name: 'mentions', type: 'relationship', hasMany: true, relationTo: 'media' },
    { name: 'manual', type: 'upload', relationTo: 'files' },
    {
      name: 'meta',
      type: 'group',
      fields: [
        { name: 'cover', type: 'upload', relationTo: 'media' },
        { name: 'note', type: 'text' },
      ],
    },
    {
      type: 'collapsible',
      fields: [{ name: 'sidebar', type: 'upload', relationTo: 'media' }],
      label: 'Sidebar',
    },
    {
      type: 'tabs',
      tabs: [
        {
          fields: [
            {
              name: 'layout',
              type: 'blocks',
              blocks: [
                {
                  slug: 'gallery',
                  fields: [
                    { name: 'image', type: 'upload', relationTo: 'media' },
                    { name: 'caption', type: 'text' },
                    {
                      name: 'credit',
                      type: 'group',
                      fields: [
                        { name: 'author', type: 'text' },
                        { name: 'portrait', type: 'upload', relationTo: 'media' },
                      ],
                    },
                  ],
                },
              ],
            },
          ],
          label: 'Content',
        },
        {
          name: 'seo',
          fields: [{ name: 'image', type: 'upload', relationTo: 'media' }],
          label: 'SEO',
        },
      ],
    },
    {
      name: 'attachments',
      type: 'array',
      fields: [
        { name: 'file', type: 'upload', relationTo: 'media' },
        { name: 'label', type: 'text' },
      ],
    },
    { name: 'body', type: 'json' },
    { name: 'spacer', type: 'ui', admin: { components: {} } },
  ],
  versions: false,
}

export const Deep: CollectionConfig = {
  slug: 'deep',
  admin: { useAsTitle: 'title' },
  fields: [
    { name: 'title', type: 'text', localized: true },
    { name: 'banner', type: 'upload', localized: true, relationTo: 'media' },
    {
      name: 'sections',
      type: 'array',
      fields: [
        {
          name: 'panel',
          type: 'group',
          fields: [
            {
              name: 'content',
              type: 'blocks',
              blocks: [
                {
                  slug: 'slideshow',
                  fields: [
                    {
                      name: 'slides',
                      type: 'array',
                      fields: [{ name: 'image', type: 'upload', relationTo: 'media' }],
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    },
    { name: 'article', type: 'richText' },
  ],
  versions: { drafts: true },
}

export const Tags: CollectionConfig = {
  slug: 'tags',
  admin: { useAsTitle: 'name' },
  fields: [
    { name: 'name', type: 'text' },
    { name: 'notes', type: 'textarea' },
  ],
  versions: false,
}

export const Settings: GlobalConfig = {
  slug: 'settings',
  fields: [
    { name: 'logo', type: 'upload', relationTo: 'media' },
    {
      name: 'branding',
      type: 'group',
      fields: [
        {
          name: 'icons',
          type: 'array',
          fields: [{ name: 'icon', type: 'upload', relationTo: 'media' }],
        },
      ],
    },
  ],
  versions: false,
}
