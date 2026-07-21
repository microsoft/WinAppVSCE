/**
 * Re-export from shared manifest-schema module.
 * This file exists for backward compatibility during the migration.
 */
export {
    XmlContextType,
    XmlContext,
    ParentElement,
    getXmlContext,
    findParentPath,
    splitPrefixedName,
} from '../manifest-schema/xml-context';
