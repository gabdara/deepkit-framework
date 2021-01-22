/*
 * Deepkit Framework
 * Copyright (C) 2021 Deepkit UG, Marc J. Schmidt
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the MIT License.
 *
 * You should have received a copy of the MIT License along with this program.
 */

import sqlite3 from 'better-sqlite3';
import {
    SQLConnection,
    SQLConnectionPool,
    SQLDatabaseAdapter,
    SQLDatabaseQuery,
    SQLDatabaseQueryFactory,
    SQLPersistence,
    SQLQueryModel,
    SQLQueryResolver,
    SQLStatement,
    DefaultPlatform,
    SqlBuilder
} from '@deepkit/sql';
import { Changes, DatabaseAdapter, DatabasePersistenceChangeSet, DatabaseSession, DeleteResult, Entity, PatchResult } from '@deepkit/orm';
import { SQLitePlatform } from './sqlite-platform';
import { ClassSchema, getClassSchema, getPropertyXtoClassFunction, resolvePropertySchema } from '@deepkit/type';
import { ClassType, empty } from '@deepkit/core';

export class SQLiteStatement extends SQLStatement {
    constructor(protected stmt: sqlite3.Statement) {
        super();
    }

    async get(params: any[] = []): Promise<any> {
        return this.stmt.get(...params);
    }

    async all(params: any[] = []): Promise<any[]> {
        return this.stmt.all(...params);
    }

    release() {
    }
}

export class SQLiteConnection extends SQLConnection {
    public platform = new SQLitePlatform();
    protected changes: number = 0;

    constructor(connectionPool: SQLConnectionPool, public readonly db: sqlite3.Database) {
        super(connectionPool);
    }

    async prepare(sql: string) {
        return new SQLiteStatement(this.db.prepare(sql));
    }

    async run(sql: string, params: any[] = []) {
        const stmt = this.db.prepare(sql);
        const result = stmt.run(...params);
        this.changes = result.changes;
    }

    async exec(sql: string) {
        try {
            this.db.exec(sql);
        } catch (error) {
            console.warn('sql', sql);
            throw error;
        }
    }

    async getChanges(): Promise<number> {
        return this.changes;
    }
}

export class SQLiteConnectionPool extends SQLConnectionPool {
    constructor(protected db: sqlite3.Database) {
        super();
    }

    getConnection(): SQLiteConnection {
        this.activeConnections++;
        return new SQLiteConnection(this, this.db);
    }
}

export class SQLitePersistence extends SQLPersistence {
    constructor(
        protected platform: DefaultPlatform,
        protected connection: SQLiteConnection,
    ) {
        super(platform, connection);
    }

    async update<T extends Entity>(classSchema: ClassSchema<T>, changeSets: DatabasePersistenceChangeSet<T>[]): Promise<void> {
        const scopeSerializer = this.platform.serializer.for(classSchema);
        const tableName = this.platform.getTableIdentifier(classSchema);
        const pkName = classSchema.getPrimaryField().name;
        const pkField = this.platform.quoteIdentifier(pkName);

        const values: { [name: string]: any[] } = {};
        const setNames: string[] = [];
        const aggregateSelects: { [name: string]: { id: any, sql: string }[] } = {};
        const requiredFields: { [name: string]: 1 } = {};

        const assignReturning: { [name: string]: { item: any, names: string[] } } = {};
        const setReturning: { [name: string]: 1 } = {};

        for (const changeSet of changeSets) {
            const where: string[] = [];

            const pk = scopeSerializer.partialSerialize(changeSet.primaryKey);
            for (const i in pk) {
                if (!pk.hasOwnProperty(i)) continue;
                where.push(`${this.platform.quoteIdentifier(i)} = ${this.platform.quoteValue(pk[i])}`);
                requiredFields[i] = 1;
            }

            if (!values[pkName]) values[pkName] = [];
            values[pkName].push(this.platform.quoteValue(changeSet.primaryKey[pkName]));

            const fieldAddedToValues: { [name: string]: 1 } = {};
            const id = changeSet.primaryKey[pkName];

            if (changeSet.changes.$set) {
                const value = scopeSerializer.partialSerialize(changeSet.changes.$set);
                for (const i in value) {
                    if (!value.hasOwnProperty(i)) continue;
                    if (!values[i]) {
                        values[i] = [];
                        setNames.push(`${this.platform.quoteIdentifier(i)} = _b.${this.platform.quoteIdentifier(i)}`);
                    }
                    requiredFields[i] = 1;
                    fieldAddedToValues[i] = 1;
                    values[i].push(this.platform.quoteValue(value[i]));
                }
            }

            if (changeSet.changes.$inc) {
                for (const i in changeSet.changes.$inc) {
                    if (!changeSet.changes.$inc.hasOwnProperty(i)) continue;
                    const value = changeSet.changes.$inc[i];
                    if (!aggregateSelects[i]) aggregateSelects[i] = [];

                    if (!values[i]) {
                        values[i] = [];
                        setNames.push(`${this.platform.quoteIdentifier(i)} = _b.${this.platform.quoteIdentifier(i)}`);
                    }

                    if (!assignReturning[id]) {
                        assignReturning[id] = { item: changeSet.item, names: [] };
                    }

                    assignReturning[id].names.push(i);
                    setReturning[i] = 1;

                    aggregateSelects[i].push({ id: changeSet.primaryKey[pkName], sql: `_origin.${this.platform.quoteIdentifier(i)} + ${this.platform.quoteValue(value)}` });
                    requiredFields[i] = 1;
                    if (!fieldAddedToValues[i]) {
                        fieldAddedToValues[i] = 1;
                        values[i].push(this.platform.quoteValue(null));
                    }
                }
            }
        }

        const selects: string[] = [];
        const valuesValues: string[] = [];
        const valuesNames: string[] = [];
        const _rename: string[] = [];

        let j = 1;
        for (const i in values) {
            valuesNames.push(i);
            _rename.push(`column${j++} as ${i}`);
        }

        for (let i = 0; i < values[pkName].length; i++) {
            valuesValues.push('(' + valuesNames.map(name => values[name][i]).join(',') + ')');
        }

        for (const i in requiredFields) {
            if (aggregateSelects[i]) {
                const select: string[] = [];
                select.push('CASE');
                for (const item of aggregateSelects[i]) {
                    select.push(`WHEN _.${pkField} = ${item.id} THEN ${item.sql}`);
                }
                select.push(`ELSE _.${this.platform.quoteIdentifier(i)} END as ${this.platform.quoteIdentifier(i)}`);
                selects.push(select.join(' '));
            } else {
                selects.push('_.' + i);
            }
        }

        const sql = `
              DROP TABLE IF EXISTS _b;
              CREATE TEMPORARY TABLE _b AS
                SELECT ${selects.join(', ')} 
                FROM (SELECT ${_rename.join(', ')} FROM (VALUES ${valuesValues.join(', ')})) as _
                INNER JOIN ${tableName} as _origin ON (_origin.${pkField} = _.${pkField});
              UPDATE 
                ${tableName}
                SET ${setNames.join(', ')}
              FROM 
                _b
              WHERE ${tableName}.${pkField} = _b.${pkField};
        `;

        await this.connection.exec(sql);

        if (!empty(setReturning)) {
            const returnings = await this.connection.execAndReturnAll('SELECT * FROM _b');
            for (const returning of returnings) {
                const r = assignReturning[returning[pkName]];

                for (const name of r.names) {
                    r.item[name] = returning[name];
                }
            }
        }
    }

    protected async populateAutoIncrementFields<T>(classSchema: ClassSchema<T>, items: T[]) {
        const autoIncrement = classSchema.getAutoIncrementField();
        if (!autoIncrement) return;

        //SQLite returns the _last_ auto-incremented value for a batch insert as last_insert_rowid().
        //Since we know how many items were inserted, we can simply calculate for each item the auto-incremented value.
        const row = await this.connection.execAndReturnSingle(`SELECT last_insert_rowid() as rowid`);
        const lastInserted = row.rowid;
        let start = lastInserted - items.length + 1;

        for (const item of items) {
            item[autoIncrement.name] = start++;
        }
    }
}

export class SQLiteQueryResolver<T extends Entity> extends SQLQueryResolver<T> {
    constructor(
        protected connectionPool: SQLiteConnectionPool,
        protected platform: DefaultPlatform,
        classSchema: ClassSchema<T>,
        databaseSession: DatabaseSession<DatabaseAdapter>) {
        super(connectionPool, platform, classSchema, databaseSession);
    }

    async delete(model: SQLQueryModel<T>, deleteResult: DeleteResult<T>): Promise<void> {
        // if (model.hasJoins()) throw new Error('Delete with joins not supported. Fetch first the ids then delete.');
        const pkName = this.classSchema.getPrimaryField().name;
        const primaryKey = this.classSchema.getPrimaryField();
        const pkField = this.platform.quoteIdentifier(primaryKey.name);
        const sqlBuilder = new SqlBuilder(this.platform);
        const select = sqlBuilder.select(this.classSchema, model, { select: [pkField] });
        const primaryKeyConverted = getPropertyXtoClassFunction(primaryKey, this.platform.serializer);

        const connection = this.connectionPool.getConnection();
        try {
            await connection.exec(`DROP TABLE IF EXISTS _tmp_d;`);
            await connection.run(`CREATE TEMPORARY TABLE _tmp_d as ${select.sql};`, select.params);

            const sql = `DELETE FROM ${this.platform.getTableIdentifier(this.classSchema)} WHERE ${pkField} IN (SELECT * FROM _tmp_d)`;
            await connection.run(sql);
            const rows = await connection.execAndReturnAll('SELECT * FROM _tmp_d');
            deleteResult.modified = await connection.getChanges();
            for (const row of rows) {
                deleteResult.primaryKeys.push(primaryKeyConverted(row[pkName]));
            }
        } finally {
            connection.release();
        }
    }

    async patch(model: SQLQueryModel<T>, changes: Changes<T>, patchResult: PatchResult<T>): Promise<void> {
        const select: string[] = [];
        const tableName = this.platform.getTableIdentifier(this.classSchema);
        const primaryKey = this.classSchema.getPrimaryField();
        const pkField = this.platform.quoteIdentifier(primaryKey.name);
        const primaryKeyConverted = getPropertyXtoClassFunction(primaryKey, this.platform.serializer);
        select.push(pkField);

        const fieldsSet: { [name: string]: 1 } = {};
        const aggregateFields: { [name: string]: { converted: (v: any) => any } } = {};

        const scopeSerializer = this.platform.serializer.for(this.classSchema);
        const $set = changes.$set ? scopeSerializer.partialSerialize(changes.$set) : undefined;

        if ($set) for (const i in $set) {
            if (!$set.hasOwnProperty(i)) continue;
            fieldsSet[i] = 1;
            select.push(`${this.platform.quoteValue($set[i])} as ${this.platform.quoteIdentifier(i)}`);
        }

        if (changes.$unset) for (const i in changes.$unset) {
            if (!changes.$unset.hasOwnProperty(i)) continue;
            fieldsSet[i] = 1;
            select.push(`NULL as ${this.platform.quoteIdentifier(i)}`);
        }

        for (const i of model.returning) {
            aggregateFields[i] = { converted: getPropertyXtoClassFunction(resolvePropertySchema(this.classSchema, i), this.platform.serializer) };
            select.push(`(${this.platform.quoteIdentifier(i)} ) as ${this.platform.quoteIdentifier(i)}`);
        }

        if (changes.$inc) for (const i in changes.$inc) {
            if (!changes.$inc.hasOwnProperty(i)) continue;
            fieldsSet[i] = 1;
            aggregateFields[i] = { converted: getPropertyXtoClassFunction(resolvePropertySchema(this.classSchema, i), this.platform.serializer) };
            select.push(`(${this.platform.quoteIdentifier(i)} + ${this.platform.quoteValue(changes.$inc[i])}) as ${this.platform.quoteIdentifier(i)}`);
        }

        const set: string[] = [];
        for (const i in fieldsSet) {
            set.push(`${this.platform.quoteIdentifier(i)} = _b.${this.platform.quoteIdentifier(i)}`);
        }

        const sqlBuilder = new SqlBuilder(this.platform);
        const selectSQL = sqlBuilder.select(this.classSchema, model, { select });

        const sql = `
              UPDATE 
                ${tableName}
              SET
                ${set.join(', ')}
              FROM 
                _b
              WHERE ${tableName}.${pkField} = _b.${pkField};
        `;

        const connection = this.connectionPool.getConnection();
        try {
            await connection.exec(`DROP TABLE IF EXISTS _b;`);
            await connection.run(`CREATE TEMPORARY TABLE _b AS ${selectSQL.sql};`, selectSQL.params);

            await connection.run(sql);
            patchResult.modified = await connection.getChanges();

            const pkName = this.classSchema.getPrimaryField().name;
            const returnings = await connection.execAndReturnAll('SELECT * FROM _b');
            for (const i in aggregateFields) {
                patchResult.returning[i] = [];
            }

            for (const returning of returnings) {
                patchResult.primaryKeys.push(primaryKeyConverted(returning[pkName]));
                for (const i in aggregateFields) {
                    patchResult.returning[i].push(aggregateFields[i].converted(returning[i]));
                }
            }

        } finally {
            connection.release();
        }
    }
}

export class SQLiteDatabaseQuery<T> extends SQLDatabaseQuery<T> {
}

export class SQLiteDatabaseQueryFactory extends SQLDatabaseQueryFactory {
    constructor(protected connectionPool: SQLiteConnectionPool, platform: DefaultPlatform, databaseSession: DatabaseSession<any>) {
        super(connectionPool, platform, databaseSession);
    }

    createQuery<T extends Entity>(
        classType: ClassType<T> | ClassSchema<T>
    ): SQLiteDatabaseQuery<T> {
        return new SQLiteDatabaseQuery(getClassSchema(classType), this.databaseSession,
            new SQLiteQueryResolver(this.connectionPool, this.platform, getClassSchema(classType), this.databaseSession)
        );
    }
}

export class SQLiteDatabaseAdapter extends SQLDatabaseAdapter {
    public readonly db: sqlite3.Database;
    public readonly connectionPool: SQLiteConnectionPool;
    public readonly platform = new SQLitePlatform();

    constructor(protected sqlitePath: string) {
        super();
        this.db = new sqlite3(sqlitePath);
        this.db.exec('PRAGMA foreign_keys=ON');

        this.connectionPool = new SQLiteConnectionPool(this.db);
    }

    getName(): string {
        return 'sqlite';
    }

    getSchemaName(): string {
        return '';
    }

    createPersistence(): SQLPersistence {
        return new SQLitePersistence(this.platform, this.connectionPool.getConnection());
    }

    queryFactory(databaseSession: DatabaseSession<any>): SQLDatabaseQueryFactory {
        return new SQLiteDatabaseQueryFactory(this.connectionPool, this.platform, databaseSession);
    }

    disconnect(force?: boolean): void {
        if (this.connectionPool.getActiveConnections() > 0) {
            throw new Error(`There are still active connections. Please release() any fetched connection first.`);
        }
        this.db.close();
    }
}